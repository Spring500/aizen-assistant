import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { type AppPreferencesStore, defaultAppPreferences, parseAppPreferences } from "./app-preferences-store.ts"
import { CoreErrorQueue } from "./error-queue.ts"
import type { ModelConfigStore } from "./model-config-store.ts"
import { normalizeProjectPath } from "./paths.ts"
import {
  PiModelRuntimeError,
  type PiPermissionExecutionEvent,
  type PiPort,
  type PiPortEvent,
  type ResolvedViewResources,
} from "./pi-port.ts"
import { resolveProjectSources } from "./project-context.ts"
import type {
  AssistantMessage,
  ModelReference,
  SessionRecord,
  TurnFinishedRecord,
  TurnInputItem,
  TurnStartedRecord,
  ViewId,
} from "./session-format.ts"
import { projectVisibleSessionRecords } from "./session-projection.ts"
import { recoverInterruptedToolCalls } from "./session-recovery.ts"
import { InvalidSessionRecordError, SessionLockedError, type SessionStore } from "./session-store.ts"
import type { SkillStore } from "./skill-store.ts"
import { PermissionClassifierRegistry } from "./tool-permissions/classifier-registry.ts"
import { createBuiltinBashClassifier } from "./tool-permissions/classifiers/bash.ts"
import { createBuiltinFileClassifier } from "./tool-permissions/classifiers/file.ts"
import { PolicyPermissionManager } from "./tool-permissions/policy-manager.ts"
import { builtinPermissionPolicies } from "./tool-permissions/policy-types.ts"
import { sanitizePermissionAuditPayload } from "./tool-permissions/sanitizer.ts"
import type { PermissionAuditRecorder } from "./tool-permissions/permission-audit.ts"
import type {
  HumanReviewBatchDecision,
  HumanReviewBatchRequest,
  PermissionAuditEvent,
  PermissionGapRecorder,
} from "./tool-permissions/types.ts"
import { type AizenToolRegistration, validateToolRegistrations } from "./tool-registry.ts"
import {
  type CoreCommand,
  type CoreCommandResult,
  type CoreEvent,
  type CorePort,
  type CoreSnapshot,
  recordsToTranscript,
} from "./types.ts"
import { readViewConfig } from "./view-config.ts"
import type { ViewStore } from "./view-store.ts"

export type ExtraMessageProvider = (input: {
  cwd: string
  sessionId: string
  turnId: string
  viewId: ViewId
  text: string
}) => Promise<TurnInputItem[]>

export type AizenCoreOptions = {
  cwd: string
  store: SessionStore
  pi: PiPort
  views?: ViewStore
  skills?: SkillStore
  extraMessages?: ExtraMessageProvider
  modelConfigStore?: ModelConfigStore
  preferencesStore?: AppPreferencesStore
  toolRegistrations?: AizenToolRegistration[]
  permissionGapRecorder?: PermissionGapRecorder
  /** 权限判定审计的本地 JSONL 落盘器（含轮转）；不提供时只写会话记录。 */
  permissionAuditRecorder?: PermissionAuditRecorder
}

function sessionModel(model: ModelReference): ModelReference {
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
  }
}

/** 让交互层依据稳定错误码采取修复动作，避免解析中文错误文本。 */
class CoreCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export class AizenCore implements CorePort {
  readonly #cwd: string
  readonly #store: SessionStore
  readonly #pi: PiPort
  readonly #views: ViewStore | undefined
  readonly #skills: SkillStore | undefined
  readonly #extraMessages: ExtraMessageProvider
  readonly #modelConfigStore: ModelConfigStore | undefined
  readonly #preferencesStore: AppPreferencesStore | undefined
  readonly #toolRegistrations: AizenToolRegistration[]
  readonly #permissionGapRecorder: PermissionGapRecorder | undefined
  readonly #permissionAuditRecorder: PermissionAuditRecorder | undefined
  readonly #listeners = new Set<(event: CoreEvent) => void>()
  readonly #unsubscribePi: () => void
  readonly #policyPermissionManager: PolicyPermissionManager | undefined
  readonly #pendingPermissionAnswers = new Map<
    string,
    { resolve: (decision: HumanReviewBatchDecision) => void; reject: (error: Error) => void }
  >()
  #snapshot: CoreSnapshot
  #sessionInitialCwd: string
  #records: SessionRecord[] = []
  #writeQueue = Promise.resolve()
  #writeError: Error | undefined
  readonly #errors = new CoreErrorQueue()
  #currentTurnId: string | undefined
  #responseTimer: ReturnType<typeof setInterval> | undefined
  #abortRequested = false
  #preferencesLoaded = false
  #sessionNamingAttempted = false
  #sessionNamingTask: Promise<void> | undefined
  #sessionNamingAbort: AbortController | undefined
  #disposed = false
  /** 流式/工具事件快照通知的合并节流：同一窗口内的多次变更合并为一次 notify。 */
  #snapshotNotifyScheduled = false

  constructor(options: AizenCoreOptions) {
    this.#cwd = options.cwd
    this.#sessionInitialCwd = options.cwd
    this.#store = options.store
    this.#pi = options.pi
    this.#snapshot = {
      cwd: options.cwd,
      status: "idle",
      sessions: [],
      models: [],
      preferences: structuredClone(defaultAppPreferences),
      views: [],
      authProviders: [],
      piProviders: [],
      transcript: [],
      activeTools: [],
      pendingPermissionRequests: [],
      streamingText: "",
      streamingThinking: "",
    }
    this.#views = options.views
    this.#skills = options.skills
    this.#extraMessages = options.extraMessages ?? (async () => [])
    this.#modelConfigStore = options.modelConfigStore
    this.#preferencesStore = options.preferencesStore
    this.#toolRegistrations = options.toolRegistrations ?? []
    this.#permissionGapRecorder = options.permissionGapRecorder
    this.#permissionAuditRecorder = options.permissionAuditRecorder
    validateToolRegistrations(this.#toolRegistrations)
    this.#unsubscribePi = this.#pi.subscribe((event) => this.#handlePiEvent(event))
    this.#policyPermissionManager = this.#createPolicyPermissionManager()
    this.#pi.setToolRegistrations?.(this.#toolRegistrations)
    this.#pi.setPermissionBatchHandler?.((batch, signal) => {
      if (!this.#policyPermissionManager)
        return Promise.resolve({
          batchId: batch.batchId,
          authorizations: batch.calls.map((request) => ({
            toolCallId: request.toolCallId,
            authorization: { type: "deny" as const, reason: "权限管理器不可用", source: "system" as const },
          })),
        })
      return this.#authorizePolicyBatch(batch, signal)
    })
    this.#pi.setPermissionHandler?.((request, signal) => {
      if (!this.#policyPermissionManager)
        return Promise.resolve({ type: "deny", reason: "权限管理器不可用", source: "system" })
      return this.#policyPermissionManager.authorize(
        request,
        {
          workspaceRoot: this.#cwd,
          homeDirectory: homedir(),
          sensitivePaths: [
            ".env",
            ".npmrc",
            ".pypirc",
            "credentials",
            "credentials.json",
            "id_rsa",
            "id_ed25519",
            ".ssh",
            ".git",
            ".aizen",
            "auth.json",
          ],
          shell:
            request.environment &&
            typeof request.environment === "object" &&
            !Array.isArray(request.environment) &&
            typeof request.environment.shell === "string"
              ? request.environment.shell
              : "unknown",
          platform: process.platform,
        },
        builtinPermissionPolicies[
          request.permissionPreset === "custom" ? "edit" : (request.permissionPreset ?? "edit")
        ],
        request.permissionReviewMode ?? "manual",
        signal,
      )
    })
    this.#pi.setPermissionExecutionHandler?.((event) => this.#recordPermissionExecution(event))
  }

  getSnapshot(): CoreSnapshot {
    return structuredClone(this.#snapshot)
  }

  subscribe(listener: (event: CoreEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** 串行执行核心命令，并把可修复状态转换为稳定错误码供交互层处理。 */
  async dispatch(command: CoreCommand): Promise<CoreCommandResult> {
    if (this.#disposed)
      return { ok: false, error: { code: "CORE_DISPOSED", message: "核心已经关闭", severity: "fatal" } }
    try {
      if (
        command.type !== "abort" &&
        command.type !== "answer_auth_prompt" &&
        command.type !== "answer_permission_batch" &&
        command.type !== "answer_permission_request" &&
        command.type !== "cancel_auth" &&
        this.#snapshot.status !== "idle"
      ) {
        throw new Error("当前操作尚未完成")
      }
      switch (command.type) {
        case "load_preferences":
          this.#snapshot.preferences = await this.#readPreferences()
          this.#preferencesLoaded = true
          break
        case "save_fold_preferences": {
          const preferences = parseAppPreferences({ ...this.#snapshot.preferences, fold: command.fold })
          await this.#writePreferences(preferences)
          break
        }
        case "save_agent_preferences": {
          const preferences = parseAppPreferences({ ...this.#snapshot.preferences, agents: command.agents })
          await this.#writePreferences(preferences)
          break
        }
        case "list_sessions":
          this.#snapshot.sessions = await this.#store.list()
          this.#reportStoreWarnings()
          break
        case "list_views":
          if (!this.#views) throw new Error("未配置视图存储")
          this.#snapshot.views = await this.#views.list()
          break
        case "list_models":
          this.#snapshot.models = await this.#pi.listModels()
          if (this.#pi.listProviders) this.#snapshot.piProviders = await this.#pi.listProviders()
          break
        case "load_model_config":
          this.#snapshot.modelConfig = await this.#requireModelConfigStore().read()
          break
        case "save_provider":
          await this.#changeModelConfig(() =>
            this.#requireModelConfigStore().upsertProvider(
              command.revision,
              command.provider,
              command.create ? "create" : "update",
            ),
          )
          break
        case "delete_provider":
          if (this.#snapshot.currentModel?.providerId === command.providerId)
            throw new Error("不能删除当前会话正在使用的供应商，请先切换模型")
          await this.#changeModelConfig(() =>
            this.#requireModelConfigStore().deleteProvider(command.revision, command.providerId),
          )
          break
        case "save_model":
          await this.#changeModelConfig(() =>
            this.#requireModelConfigStore().upsertModel(
              command.revision,
              command.providerId,
              command.model,
              command.create ? "create" : "update",
            ),
          )
          break
        case "delete_model":
          if (
            this.#snapshot.currentModel?.providerId === command.providerId &&
            this.#snapshot.currentModel.modelId === command.modelId
          )
            throw new Error("不能删除当前会话正在使用的模型，请先切换模型")
          await this.#changeModelConfig(() =>
            this.#requireModelConfigStore().deleteModel(command.revision, command.providerId, command.modelId),
          )
          break
        case "list_auth_providers":
          this.#snapshot.authProviders = await this.#pi.listAuthProviders()
          break
        case "list_pi_providers":
          if (!this.#pi.listProviders) throw new Error("当前运行模式不支持 pi 供应商管理")
          this.#snapshot.piProviders = await this.#pi.listProviders()
          break
        case "set_pi_provider_enabled":
          if (!this.#pi.setProviderEnabled) throw new Error("当前运行模式不支持 pi 供应商管理")
          await this.#pi.setProviderEnabled(command.providerId, command.enabled)
          this.#snapshot.piProviders = (await this.#pi.listProviders?.()) ?? []
          if (this.#snapshot.currentSessionId) await this.#tryActivateCurrentRecords()
          break
        case "refresh_pi_provider":
          if (!this.#pi.refreshProvider) throw new Error("当前运行模式不支持 pi 供应商管理")
          this.#snapshot.status = "refreshing"
          this.#notify()
          try {
            await this.#pi.refreshProvider(command.providerId)
          } finally {
            this.#snapshot.status = "idle"
          }
          this.#snapshot.models = await this.#pi.listModels()
          this.#snapshot.piProviders = (await this.#pi.listProviders?.()) ?? []
          break
        case "login_pi_provider":
          if (!this.#pi.loginProvider) throw new Error("当前运行模式不支持 pi 供应商管理")
          this.#snapshot.status = "authenticating"
          this.#notify()
          try {
            await this.#pi.loginProvider(command.providerId, command.authType)
          } finally {
            this.#snapshot.status = "idle"
          }
          this.#snapshot.piProviders = (await this.#pi.listProviders?.()) ?? []
          break
        case "create_session":
          await this.#createSession(
            command.model,
            command.viewId,
            command.permissionPreset ?? this.#snapshot.preferences.newSession.permissionPreset ?? "edit",
            command.permissionReviewMode ?? this.#snapshot.preferences.newSession.permissionReviewMode ?? "manual",
          )
          break
        case "open_session":
          await this.#openSession(command.sessionId)
          break
        case "rename_session":
          await this.#renameSession(command.sessionId, command.name)
          break
        case "rewind":
          await this.#rewind(command.turnId)
          break
        case "fork_session":
          await this.#forkSession(command.turnId)
          break
        case "send_prompt":
          await this.#sendPrompt(command.text)
          break
        case "compact":
          await this.#compact(command.customInstructions)
          break
        case "abort":
          if (this.#snapshot.status === "running" || this.#snapshot.status === "compacting") {
            this.#abortRequested = true
            this.#snapshot.status = "aborting"
            this.#notify()
            await this.#pi.abort()
            this.#cancelPendingPermissions("本轮已经中止")
          }
          break
        case "set_view":
          await this.#setView(command.viewId)
          break
        case "set_permission_settings": {
          const sessionId = this.#snapshot.currentSessionId
          if (!sessionId) throw new Error("当前没有打开的会话")
          const record: SessionRecord = {
            kind: "permission_settings_changed",
            recordId: crypto.randomUUID(),
            at: new Date().toISOString(),
            preset: command.preset,
            reviewMode: command.reviewMode,
          }
          await this.#store.append(sessionId, record)
          this.#records.push(record)
          this.#snapshot.currentPermissionPreset = command.preset
          this.#snapshot.currentPermissionReviewMode = command.reviewMode
          break
        }
        case "answer_permission_batch":
          this.#answerPermissionBatch(command.batchId, command.answers)
          break
        case "answer_permission_request": {
          const request = (this.#snapshot.pendingPermissionRequests ?? []).find(
            (item) => item.requestId === command.requestId,
          )
          if (!request) throw new Error("当前没有等待答复的工具权限请求")
          this.#answerPermissionBatch(request.batchId, [
            {
              requestId: request.requestId,
              type: command.decision,
              ...(command.decision === "deny" && command.reason ? { reason: command.reason } : {}),
            },
          ])
          break
        }
        case "create_view":
          if (!this.#views) throw new Error("未配置视图存储")
          await this.#views.create({ name: command.name, ...(command.id === undefined ? {} : { id: command.id }) })
          this.#snapshot.views = await this.#views.list()
          break
        case "update_view":
          if (!this.#views) throw new Error("未配置视图存储")
          await this.#views.update(command.viewId, {
            ...(command.name === undefined ? {} : { name: command.name }),
            ...(command.path === undefined ? {} : { path: command.path }),
          })
          this.#snapshot.views = await this.#views.list()
          break
        case "ensure_view_file":
          if (!this.#views) throw new Error("未配置视图存储")
          await this.#views.ensureFile(command.viewId, command.name)
          break
        case "remove_view":
          if (!this.#views) throw new Error("未配置视图存储")
          if (this.#snapshot.currentViewId === command.viewId) throw new Error("不能移除当前会话正在使用的视图")
          if (command.deleteDirectory) await this.#views.deleteDirectory(command.viewId)
          else await this.#views.remove(command.viewId)
          this.#snapshot.views = await this.#views.list()
          break
        case "set_model":
          await this.#setModel(command.model)
          break
        case "login_api_key":
          this.#snapshot.status = "authenticating"
          this.#notify()
          try {
            await this.#pi.loginApiKey(command.providerId)
          } finally {
            this.#snapshot.status = "idle"
          }
          this.#snapshot.authProviders = await this.#pi.listAuthProviders()
          break
        case "answer_auth_prompt":
          this.#pi.answerAuthPrompt(command.promptId, command.value)
          break
        case "cancel_auth":
          this.#pi.cancelAuth()
          break
      }
      this.#notify()
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#reportError(message)
      if (this.#snapshot.status !== "running" && this.#snapshot.status !== "aborting") this.#snapshot.status = "idle"
      this.#notify()
      // 只有需要交互层继续处理的错误使用专用错误码，其余异常统一返回 COMMAND_FAILED。
      return {
        ok: false,
        error: {
          code:
            error instanceof CoreCommandError
              ? error.code
              : error instanceof SessionLockedError
                ? error.code
                : "COMMAND_FAILED",
          message,
          severity: "error",
        },
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    let failure: unknown
    try {
      this.#sessionNamingAbort?.abort()
      this.#cancelPendingPermissions("核心已经关闭")
      if (
        this.#snapshot.status === "running" ||
        this.#snapshot.status === "compacting" ||
        this.#snapshot.status === "aborting"
      )
        await this.#pi.abort()
    } catch (error) {
      failure = error
    } finally {
      this.#stopResponseTimer()
      try {
        await this.#sessionNamingTask
        await this.#writeQueue
        await this.#store.flush()
      } catch (error) {
        failure ??= error
      } finally {
        this.#unsubscribePi()
        try {
          await this.#pi.dispose()
          await this.#permissionGapRecorder?.close?.()
          await this.#permissionAuditRecorder?.close?.()
        } catch (error) {
          failure ??= error
        } finally {
          this.#listeners.clear()
        }
      }
    }
    if (failure !== undefined) throw failure
  }

  async #readPreferences() {
    if (!this.#preferencesStore) return structuredClone(this.#snapshot.preferences)
    const preferences = await this.#preferencesStore.read()
    this.#reportPreferenceWarnings()
    return preferences
  }

  async #writePreferences(preferences: CoreSnapshot["preferences"]): Promise<void> {
    if (this.#preferencesStore) await this.#preferencesStore.write(preferences)
    this.#snapshot.preferences = preferences
    this.#preferencesLoaded = true
  }

  /** 仅保存新会话默认值，不参与当前会话记录和 runtime 的一致性判断。 */
  async #rememberSessionDefaults(model: ModelReference, viewId: ViewId): Promise<void> {
    if (!this.#preferencesLoaded) {
      this.#snapshot.preferences = await this.#readPreferences()
      this.#preferencesLoaded = true
    }
    await this.#writePreferences({
      ...this.#snapshot.preferences,
      newSession: {
        model: sessionModel(model),
        viewId,
        permissionPreset: this.#snapshot.currentPermissionPreset ?? "edit",
        permissionReviewMode: this.#snapshot.currentPermissionReviewMode ?? "manual",
      },
    })
  }

  /** 会话操作落盘后，默认偏好只是便利设置；写入失败应提示，但不能把已完成的操作报告为失败。 */
  async #tryRememberSessionDefaults(model: ModelReference, viewId: ViewId): Promise<void> {
    try {
      await this.#rememberSessionDefaults(model, viewId)
    } catch (error) {
      this.#reportError(`保存默认会话设置失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #requireModelConfigStore(): ModelConfigStore {
    if (!this.#modelConfigStore) throw new Error("当前运行模式不支持编辑模型配置")
    return this.#modelConfigStore
  }

  /**
   * 配置文件本身无效时回滚；配置合法但当前会话不再兼容时保留配置，
   * 并由 runtimeIssue 阻止发送，等待用户为该会话重新选择运行参数。
   */
  async #changeModelConfig(change: () => Promise<string>): Promise<void> {
    const store = this.#requireModelConfigStore()
    const previous = await store.source()
    await change()
    try {
      await this.#pi.reloadModelConfig()
    } catch (error) {
      await store.restore(previous)
      await this.#pi.reloadModelConfig()
      throw new Error(`模型配置未生效，已恢复原配置：${error instanceof Error ? error.message : String(error)}`)
    }
    this.#snapshot.modelConfig = await store.read()
    this.#snapshot.models = await this.#pi.listModels()
    if (this.#snapshot.currentSessionId) await this.#tryActivateCurrentRecords()
  }

  /** 先成功创建 pi runtime，再原子创建会话，避免留下无法运行的空会话。 */
  async #createSession(
    model: ModelReference,
    viewId: ViewId,
    permissionPreset?: import("./tool-permissions/policy-types.ts").PermissionPresetId,
    permissionReviewMode?: import("./tool-permissions/policy-types.ts").PermissionReviewMode,
  ): Promise<void> {
    this.#sessionNamingAbort?.abort()
    const at = new Date().toISOString()
    const view = await this.#resolveView(viewId)
    const actualModel = await this.#pi.create({ cwd: this.#cwd, model, view })
    const records: SessionRecord[] = [
      { kind: "model_changed", recordId: crypto.randomUUID(), at, model: sessionModel(actualModel) },
      { kind: "view_changed", recordId: crypto.randomUUID(), at, viewId },
      ...(permissionPreset
        ? [
            {
              kind: "permission_settings_changed" as const,
              recordId: crypto.randomUUID(),
              at,
              preset: permissionPreset,
              reviewMode: permissionReviewMode ?? "manual",
            },
          ]
        : []),
    ]
    const header = await this.#store.createGeneratedAndOpen({ cwd: this.#cwd, createdAt: at }, records)
    const sessionId = header.sessionId
    await this.#store.activate(sessionId)
    this.#sessionInitialCwd = header.cwd
    this.#records = records
    this.#writeError = undefined
    this.#snapshot.currentSessionId = sessionId
    this.#snapshot.currentSessionName = ""
    this.#sessionNamingAttempted = false
    delete this.#snapshot.runtimeIssue
    this.#snapshot.currentModel = actualModel
    this.#snapshot.contextUsage = this.#contextUsageFromRecords()
    this.#snapshot.currentViewId = viewId
    if (permissionPreset) {
      this.#snapshot.currentPermissionPreset = permissionPreset
      this.#snapshot.currentPermissionReviewMode = permissionReviewMode ?? "manual"
    } else {
      delete this.#snapshot.currentPermissionPreset
      delete this.#snapshot.currentPermissionReviewMode
    }
    this.#snapshot.pendingPermissionRequests = []
    this.#snapshot.transcript = []
    this.#snapshot.streamingText = ""
    this.#snapshot.streamingThinking = ""
    delete this.#snapshot.responseMetrics
    this.#snapshot.contextUsage = this.#contextUsageFromRecords()
    this.#snapshot.sessions = await this.#store.list()
    this.#reportStoreWarnings()
    await this.#tryRememberSessionDefaults(actualModel, viewId)
  }

  /**
   * 打开会话首先是纯本地历史操作。即使当前模型或视图已经失效，
   * 对话记录也必须可见；无法重建 pi 内存会话时只禁止发送新消息。
   */
  async #openSession(sessionId: string): Promise<void> {
    this.#sessionNamingAbort?.abort()
    const loaded = await this.#store.open(sessionId)
    try {
      const previousCwd = this.#effectiveWorkingDirectory(loaded.header.cwd, loaded.records)
      if (normalizeProjectPath(previousCwd) !== normalizeProjectPath(this.#cwd)) {
        const record: SessionRecord = {
          kind: "working_directory_changed",
          recordId: crypto.randomUUID(),
          at: new Date().toISOString(),
          previousCwd,
          currentCwd: this.#cwd,
        }
        await this.#store.append(sessionId, record)
        loaded.records.push(record)
      }
      const modelRecord = [...loaded.records].reverse().find((record) => record.kind === "model_changed")
      const viewRecord = [...loaded.records].reverse().find((record) => record.kind === "view_changed")
      if (modelRecord?.kind !== "model_changed") throw new Error("会话没有模型记录")
      if (viewRecord?.kind !== "view_changed") throw new Error("会话没有视图记录")
      const recoveryRecords = this.#recoverInterruptedTools(loaded.records)
      if (recoveryRecords.length > 0) {
        for (const record of recoveryRecords) await this.#store.append(sessionId, record)
        loaded.records.push(...recoveryRecords)
      }
      this.#records = loaded.records
      this.#sessionInitialCwd = this.#originalWorkingDirectory(loaded.header.cwd, loaded.records)
      this.#writeError = undefined
      this.#snapshot.currentSessionId = sessionId
      this.#sessionNamingAttempted = false
      const renamedRecord = [...loaded.records].reverse().find((record) => record.kind === "session_renamed")
      this.#snapshot.currentSessionName = renamedRecord?.kind === "session_renamed" ? renamedRecord.name : ""
      this.#snapshot.currentModel = modelRecord.model
      this.#snapshot.contextUsage = this.#contextUsageFromRecords()
      this.#snapshot.currentViewId = viewRecord.viewId
      const permissionSettings = [...loaded.records]
        .reverse()
        .find((record) => record.kind === "permission_settings_changed")
      if (permissionSettings?.kind === "permission_settings_changed") {
        this.#snapshot.currentPermissionPreset = permissionSettings.preset
        this.#snapshot.currentPermissionReviewMode = permissionSettings.reviewMode
      } else {
        delete this.#snapshot.currentPermissionPreset
        delete this.#snapshot.currentPermissionReviewMode
      }
      this.#snapshot.pendingPermissionRequests = []
      const visibleRecords = projectVisibleSessionRecords(loaded.records)
      this.#snapshot.transcript = recordsToTranscript(visibleRecords)
      this.#snapshot.streamingText = ""
      this.#snapshot.streamingThinking = ""
      delete this.#snapshot.responseMetrics
      delete this.#snapshot.runtimeIssue
      await this.#tryActivateCurrentRecords()
      if (loaded.warnings.length > 0) this.#reportError(loaded.warnings.join("；"))
      else if (recoveryRecords.length > 0)
        this.#reportError("检测到上次异常退出时存在未完成的工具调用；已记录中断状态，未自动重试")
      await this.#tryRememberSessionDefaults(this.#snapshot.currentModel, viewRecord.viewId)
      await this.#store.activate(sessionId)
      this.#snapshot.sessions = await this.#store.list()
      this.#reportStoreWarnings()
    } catch (error) {
      await this.#store.close(sessionId).catch(() => {})
      throw error
    }
  }

  #recoverInterruptedTools(records: SessionRecord[]): SessionRecord[] {
    return recoverInterruptedToolCalls(records)
  }

  /**
   * rewind/fork 落盘后无条件采用新记录，再尝试重建 pi 内存会话。
   * 这样不会出现磁盘已经变更、界面却仍声称历史操作失败的半状态。
   */
  async #activateRecords(
    sessionId: string,
    records: SessionRecord[],
    name: string,
    resetNamingOpportunity: boolean,
  ): Promise<void> {
    const modelRecord = [...records].reverse().find((record) => record.kind === "model_changed")
    const viewRecord = [...records].reverse().find((record) => record.kind === "view_changed")
    if (modelRecord?.kind !== "model_changed") throw new Error("会话没有模型记录")
    if (viewRecord?.kind !== "view_changed") throw new Error("会话没有视图记录")
    this.#records = records
    this.#writeError = undefined
    this.#snapshot.currentSessionId = sessionId
    this.#snapshot.currentSessionName = name
    if (resetNamingOpportunity) {
      this.#sessionNamingAbort?.abort()
      this.#sessionNamingAttempted = false
    }
    this.#snapshot.currentModel = modelRecord.model
    this.#snapshot.currentViewId = viewRecord.viewId
    this.#snapshot.pendingPermissionRequests = []
    this.#snapshot.transcript = recordsToTranscript(projectVisibleSessionRecords(records))
    this.#snapshot.streamingText = ""
    this.#snapshot.streamingThinking = ""
    delete this.#snapshot.responseMetrics
    this.#snapshot.contextUsage = this.#contextUsageFromRecords()
    delete this.#snapshot.runtimeIssue
    await this.#tryActivateCurrentRecords()
  }

  /**
   * 用会话当前设置和完整历史重建 pi 内存会话。失败时记录原因并禁止发送，
   * 但不让失败覆盖已经完成的打开、回退或创建分支操作。
   */
  async #tryActivateCurrentRecords(): Promise<void> {
    const model = this.#snapshot.currentModel
    const viewId = this.#snapshot.currentViewId
    if (!model || viewId === undefined) return
    let view: ResolvedViewResources
    try {
      view = await this.#resolveView(viewId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#snapshot.runtimeIssue = { kind: "view", message }
      this.#reportError(message)
      return
    }
    try {
      const actual = await this.#pi.restore({ cwd: this.#cwd, model, view, records: this.#records })
      this.#snapshot.currentModel = actual
      delete this.#snapshot.runtimeIssue
      await this.#tryRememberSessionDefaults(actual, viewId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#snapshot.runtimeIssue = {
        kind: error instanceof PiModelRuntimeError ? "model" : "runtime",
        message,
      }
      this.#reportError(message)
    }
  }

  #turnStartIndex(turnId: string): number {
    const index = this.#records.findIndex((record) => record.kind === "turn_started" && record.turnId === turnId)
    if (index < 0) throw new Error("找不到所选对话轮次")
    const finished = this.#records.some((record) => record.kind === "turn_finished" && record.turnId === turnId)
    if (!finished) throw new Error("只能选择已完成的对话轮次")
    return index
  }

  #recordsBeforeTurn(turnId: string, name: string, forceName = false): SessionRecord[] {
    const model = this.#snapshot.currentModel
    const viewId = this.#snapshot.currentViewId
    if (!model || viewId === undefined) throw new Error("当前会话设置不完整")
    const at = new Date().toISOString()
    const renamed = forceName || this.#records.some((record) => record.kind === "session_renamed")
    const retained = structuredClone(this.#records.slice(0, this.#turnStartIndex(turnId)))
    const previousCwd = this.#effectiveWorkingDirectory(this.#sessionInitialCwd, retained)
    return [
      ...retained,
      { kind: "model_changed", recordId: crypto.randomUUID(), at, model: sessionModel(model) },
      { kind: "view_changed", recordId: crypto.randomUUID(), at, viewId },
      ...(renamed ? [{ kind: "session_renamed" as const, recordId: crypto.randomUUID(), at, name }] : []),
      ...(normalizeProjectPath(previousCwd) === normalizeProjectPath(this.#cwd)
        ? []
        : [
            {
              kind: "working_directory_changed" as const,
              recordId: crypto.randomUUID(),
              at,
              previousCwd,
              currentCwd: this.#cwd,
            },
          ]),
    ]
  }

  #effectiveWorkingDirectory(initialCwd: string, records: SessionRecord[]): string {
    const latest = [...records].reverse().find((record) => record.kind === "working_directory_changed")
    return latest?.kind === "working_directory_changed" ? latest.currentCwd : initialCwd
  }

  #originalWorkingDirectory(initialCwd: string, records: SessionRecord[]): string {
    const first = records.find((record) => record.kind === "working_directory_changed")
    return first?.kind === "working_directory_changed" ? first.previousCwd : initialCwd
  }

  /**
   * 删除所选轮次及其后的对话，但保留用户执行回退时正在使用的模型和视图。
   * 因此 rewind 是对话内容回退，不会恢复所选轮次当时的模型设置。
   */
  async #rewind(turnId: string): Promise<void> {
    const sessionId = this.#snapshot.currentSessionId
    if (!sessionId) throw new Error("请先新建或恢复会话")
    await this.#writeQueue
    if (this.#writeError) throw this.#writeError
    const name = this.#snapshot.currentSessionName ?? ""
    const records = this.#recordsBeforeTurn(turnId, name)
    await this.#store.rewrite(sessionId, this.#records, records)
    await this.#activateRecords(sessionId, records, name, false)
    this.#snapshot.sessions = await this.#store.list()
    this.#reportStoreWarnings()
  }

  async #forkSession(turnId: string): Promise<void> {
    const sourceSessionId = this.#snapshot.currentSessionId
    if (!sourceSessionId) throw new Error("请先新建或恢复会话")
    await this.#writeQueue
    if (this.#writeError) throw this.#writeError
    const at = new Date().toISOString()
    const sourceName = this.#snapshot.currentSessionName || sourceSessionId
    const name = `${sourceName}_副本`
    const records = this.#recordsBeforeTurn(turnId, name, true)
    const header = await this.#store.createGeneratedAndOpen({ cwd: this.#cwd, createdAt: at }, records)
    const sessionId = header.sessionId
    await this.#store.activate(sessionId)
    this.#sessionInitialCwd = this.#originalWorkingDirectory(header.cwd, records)
    await this.#activateRecords(sessionId, records, name, true)
    this.#snapshot.sessions = await this.#store.list()
    this.#reportStoreWarnings()
  }

  async #renameSession(sessionId: string, name: string): Promise<void> {
    const normalizedName = name.trim()
    await this.#store.read(sessionId)
    const record: SessionRecord = {
      kind: "session_renamed",
      recordId: crypto.randomUUID(),
      at: new Date().toISOString(),
      name: normalizedName,
    }
    await this.#appendRecord(sessionId, record)
    if (this.#snapshot.currentSessionId === sessionId) this.#snapshot.currentSessionName = normalizedName
    this.#snapshot.sessions = await this.#store.list()
    this.#reportStoreWarnings()
  }

  /**
   * 在任何模型调用前完成 runtime 检查和 turn_started 落盘；一旦落盘，
   * 无论模型成功、失败或中止都负责补齐 turn_finished 并恢复空闲状态。
   */
  async #sendPrompt(text: string): Promise<void> {
    const sessionId = this.#snapshot.currentSessionId
    const viewId = this.#snapshot.currentViewId
    if (!sessionId || viewId === undefined) throw new Error("请先新建或恢复会话")
    if (!text.trim()) throw new Error("消息不能为空")
    if (this.#writeError) throw new Error(`会话持久化异常，请重新打开会话：${this.#writeError.message}`)
    // 必须在写入 turn_started 前拒绝发送，否则重新选择模型后会留下一个未实际发送的失败轮次。
    if (this.#snapshot.runtimeIssue) {
      const code =
        this.#snapshot.runtimeIssue.kind === "model"
          ? "MODEL_SELECTION_REQUIRED"
          : this.#snapshot.runtimeIssue.kind === "view"
            ? "VIEW_SELECTION_REQUIRED"
            : "RUNTIME_NOT_READY"
      throw new CoreCommandError(code, this.#snapshot.runtimeIssue.message)
    }
    const view = await this.#resolveView(viewId)
    await this.#pi.refreshView(view)
    const turnId = crypto.randomUUID()
    const extraItems = await this.#extraMessages({ cwd: this.#cwd, sessionId, turnId, viewId, text })
    const items: TurnInputItem[] = [
      ...extraItems,
      { source: "user", role: "user", useLater: true, parts: [{ kind: "text", text }] },
    ]
    const firstUserMessage = this.#firstUserMessage() ?? text
    const started: TurnStartedRecord = {
      kind: "turn_started",
      recordId: crypto.randomUUID(),
      turnId,
      at: new Date().toISOString(),
      viewId,
      items,
    }
    await this.#store.append(sessionId, started)
    this.#records.push(started)
    this.#currentTurnId = turnId
    this.#snapshot.transcript.push({ type: "input", turnId, items: started.items })
    this.#snapshot.status = "running"
    this.#snapshot.streamingText = ""
    this.#snapshot.streamingThinking = ""
    this.#snapshot.responseMetrics = { startedAt: Date.now(), elapsedSeconds: 0, outputTokens: 0 }
    this.#startResponseTimer()
    this.#abortRequested = false
    this.#notify()
    this.#startSessionNaming(sessionId, firstUserMessage)
    let outcome: TurnFinishedRecord["outcome"] = "completed"
    let error: TurnFinishedRecord["error"]
    try {
      await this.#pi.prompt({
        recordId: started.recordId,
        sessionId,
        turnId,
        viewId,
        ...(this.#snapshot.currentPermissionPreset ? { permissionPreset: this.#snapshot.currentPermissionPreset } : {}),
        ...(this.#snapshot.currentPermissionReviewMode
          ? { permissionReviewMode: this.#snapshot.currentPermissionReviewMode }
          : {}),
        items: started.items,
      })
      if (this.#abortRequested) outcome = "aborted"
    } catch (caught) {
      outcome = this.#abortRequested ? "aborted" : "failed"
      if (outcome === "failed")
        error = { code: "PI_REQUEST_FAILED", message: caught instanceof Error ? caught.message : String(caught) }
    }
    try {
      await this.#writeQueue
      if (this.#writeError) throw this.#writeError
      const lastMessage = [...this.#records]
        .reverse()
        .find((record) => record.kind === "message" && record.turnId === turnId)
      if (lastMessage?.kind === "message" && lastMessage.message.role === "assistant") {
        if (lastMessage.message.stopReason === "aborted") outcome = "aborted"
        if (lastMessage.message.stopReason === "error") {
          outcome = "failed"
          error = {
            code: "PI_REQUEST_FAILED",
            message: lastMessage.message.errorMessage ?? "模型请求失败",
          }
        }
      }
      const finished: TurnFinishedRecord = {
        kind: "turn_finished",
        recordId: crypto.randomUUID(),
        turnId,
        at: new Date().toISOString(),
        outcome,
        ...(error ? { error } : {}),
      }
      try {
        await this.#store.append(sessionId, finished)
      } catch (caught) {
        const actual = caught instanceof Error ? caught : new Error(String(caught))
        this.#markWriteFailure(actual)
        throw actual
      }
      this.#records.push(finished)
      this.#snapshot.transcript.push({ type: "turn_end", turnId, outcome })
      if (error) this.#reportError(error.message)
    } finally {
      this.#snapshot.status = "idle"
      this.#stopResponseTimer()
      this.#snapshot.activeTools = []
      this.#snapshot.streamingText = ""
      this.#snapshot.streamingThinking = ""
      if (this.#snapshot.responseMetrics) this.#snapshot.responseMetrics.elapsedSeconds = this.#elapsedSeconds()
      delete this.#snapshot.responseMetrics
      this.#currentTurnId = undefined
      this.#notify()
    }
  }

  /** 手动压缩不创建对话轮次，压缩记录由 adapter 事件沿用现有写入链路。 */
  async #compact(customInstructions?: string): Promise<void> {
    const sessionId = this.#snapshot.currentSessionId
    if (!sessionId) throw new Error("请先新建或恢复会话")
    if (this.#writeError) throw new Error(`会话持久化异常，请重新打开会话：${this.#writeError.message}`)
    if (this.#snapshot.runtimeIssue) throw new Error(this.#snapshot.runtimeIssue.message)
    this.#snapshot.status = "compacting"
    this.#notify()
    try {
      await this.#pi.compact(customInstructions)
      await this.#writeQueue
      if (this.#writeError) throw this.#writeError
    } finally {
      this.#snapshot.status = "idle"
      this.#notify()
    }
  }

  /** 切换视图会用现有历史重建 runtime，因此也能修复视图失效状态。 */
  async #setView(viewId: ViewId): Promise<void> {
    const sessionId = this.#snapshot.currentSessionId
    if (!sessionId) throw new Error("请先新建或恢复会话")
    const previousModel = this.#snapshot.currentModel
    const previousViewId = this.#snapshot.currentViewId
    const previousIssue = this.#snapshot.runtimeIssue
    if (!previousModel || previousViewId === undefined) throw new Error("当前会话缺少运行设置")
    const view = await this.#resolveView(viewId)
    const actual = await this.#pi.restore({ cwd: this.#cwd, model: previousModel, view, records: this.#records })
    const record: SessionRecord = {
      kind: "view_changed",
      recordId: crypto.randomUUID(),
      at: new Date().toISOString(),
      viewId,
    }
    try {
      await this.#store.append(sessionId, record)
    } catch (error) {
      const rollbackError = await this.#restoreRuntimeAfterPersistenceFailure(
        previousModel,
        previousViewId,
        previousIssue,
      )
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(rollbackError ? `${message}；恢复原运行设置失败：${rollbackError.message}` : message)
    }
    this.#records.push(record)
    this.#snapshot.currentViewId = viewId
    this.#snapshot.currentModel = actual
    delete this.#snapshot.runtimeIssue
    await this.#tryRememberSessionDefaults(actual, viewId)
  }

  /**
   * 组装视图装载资源：
   * - 无视图：内建提示词 + 项目上下文 + 用户层（原生体验）。
   * - 有视图：SYSTEM.md 覆盖系统提示词；AGENTS.md 拼接在项目链之后；
   *   skillPaths 顺序即优先级（视图自带 > 用户层 > 项目层）。
   * 配置解析失败只报告、不阻塞（缺失或非法均按默认值处理）。
   */
  async #resolveView(viewId: ViewId): Promise<ResolvedViewResources> {
    if (viewId === null) {
      const user = this.#skills ? await this.#skills.resolveUserSkills() : { paths: [], missing: [] }
      for (const name of user.missing) this.#reportError(`已安装的 skill 目录缺失：${name}`)
      const project = resolveProjectSources(this.#cwd, "pi-default")
      return {
        viewId: null,
        agentsFiles: project.agentsFiles,
        skillPaths: [...user.paths, ...project.skillPaths],
      }
    }
    const directory = this.#views ? (await this.#views.resolve(viewId)).directory : this.#cwd
    const read = await readViewConfig(directory)
    if (read.error) this.#reportError(`${viewId}：${read.error}`)
    const config = read.config
    const user =
      config.loadUserSkills && this.#skills ? await this.#skills.resolveUserSkills() : { paths: [], missing: [] }
    for (const name of user.missing) this.#reportError(`已安装的 skill 目录缺失：${name}`)
    const project =
      config.projectSources !== "none" ? resolveProjectSources(this.#cwd, config.projectSources) : undefined
    const projectAgents = project?.agentsFiles ?? []
    const projectSkills = project?.skillPaths ?? []
    const viewSkillsPath = join(directory, "skills")
    const viewSkills = existsSync(viewSkillsPath) ? [viewSkillsPath] : []
    const systemFile = await this.#readOptionalTextFile(join(directory, "SYSTEM.md"))
    const viewAgents = await this.#readOptionalTextFile(join(directory, "AGENTS.md"))
    return {
      viewId,
      ...(systemFile ? { systemPrompt: systemFile.content } : {}),
      agentsFiles: [...projectAgents, ...(viewAgents ? [viewAgents] : [])],
      skillPaths: [...viewSkills, ...user.paths, ...projectSkills],
    }
  }

  async #readOptionalTextFile(path: string): Promise<{ path: string; content: string } | undefined> {
    try {
      return { path, content: await readFile(path, "utf8") }
    } catch {
      return undefined
    }
  }

  /**
   * pi 内存会话可用时直接切换模型；不可用时必须从完整历史重新创建，
   * 使发送时弹出的模型选择无需用户先重新打开会话。
   */
  async #setModel(model: ModelReference): Promise<void> {
    const sessionId = this.#snapshot.currentSessionId
    if (!sessionId) throw new Error("请先新建或恢复会话")
    const previousModel = this.#snapshot.currentModel
    const previousViewId = this.#snapshot.currentViewId
    const previousIssue = this.#snapshot.runtimeIssue
    if (!previousModel || previousViewId === undefined) throw new Error("当前会话缺少运行设置")
    let actual: ModelReference
    if (this.#snapshot.runtimeIssue) {
      const view = await this.#resolveView(previousViewId)
      actual = await this.#pi.restore({ cwd: this.#cwd, model, view, records: this.#records })
    } else actual = await this.#pi.setModel(model)
    const record: SessionRecord = {
      kind: "model_changed",
      recordId: crypto.randomUUID(),
      at: new Date().toISOString(),
      model: sessionModel(actual),
    }
    try {
      await this.#store.append(sessionId, record)
    } catch (error) {
      const rollbackError = await this.#restoreRuntimeAfterPersistenceFailure(
        previousModel,
        previousViewId,
        previousIssue,
      )
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(rollbackError ? `${message}；恢复原运行设置失败：${rollbackError.message}` : message)
    }
    this.#records.push(record)
    this.#snapshot.currentModel = actual
    delete this.#snapshot.runtimeIssue
    this.#snapshot.contextUsage = this.#contextUsageFromRecords()
    await this.#tryRememberSessionDefaults(actual, this.#snapshot.currentViewId ?? null)
  }

  /**
   * 模型或视图已经切到 pi、但会话记录写入失败时，以磁盘仍保存的旧设置为真值重建 runtime。
   * 若旧设置本来就失效，则恢复原 runtimeIssue 并继续禁止发送，不能让未落盘的新 runtime 被误用。
   */
  async #restoreRuntimeAfterPersistenceFailure(
    model: ModelReference,
    viewId: ViewId,
    previousIssue: CoreSnapshot["runtimeIssue"],
  ): Promise<Error | undefined> {
    try {
      const view = await this.#resolveView(viewId)
      await this.#pi.restore({ cwd: this.#cwd, model, view, records: this.#records })
      if (previousIssue) this.#snapshot.runtimeIssue = previousIssue
      else delete this.#snapshot.runtimeIssue
      return undefined
    } catch (error) {
      const actual = error instanceof Error ? error : new Error(String(error))
      this.#snapshot.runtimeIssue = previousIssue ?? { kind: "runtime", message: actual.message }
      return actual
    }
  }

  #createPolicyPermissionManager(): PolicyPermissionManager | undefined {
    if (!this.#pi.setPermissionHandler) return undefined
    const registry = new PermissionClassifierRegistry()
    registry.registerBuiltin(createBuiltinBashClassifier())
    registry.registerBuiltin(createBuiltinFileClassifier())
    // 第三方工具的可选分类器与内置分类器并集生效；未提供的工具按 unknown 人工兜底。
    for (const registration of this.#toolRegistrations) {
      if (registration.classifier) registry.registerUser(registration.classifier)
    }
    return new PolicyPermissionManager({
      registry,
      aiReviewer: {
        review: (request, signal) => {
          const model = this.#snapshot.preferences.agents.permissionReview?.model
          if (!model || !this.#pi.permissionReviewer) throw new Error("未配置可用的工具审核模型")
          return this.#pi.permissionReviewer(model).review(request, signal)
        },
      },
      humanReviewer: { review: (request, signal) => this.#requestPermissionAnswer(request, signal) },
      audit: (event) => {
        void this.#recordPermissionAudit(event)
        void this.#permissionAuditRecorder?.record(event)
      },
    })
  }

  async #authorizePolicyBatch(
    batch: import("./tool-permissions/types.ts").ToolPermissionBatchRequest,
    signal?: AbortSignal,
  ): Promise<import("./tool-permissions/types.ts").ToolPermissionBatchAuthorization> {
    if (!this.#policyPermissionManager) throw new Error("新权限管理器不可用")
    const first = batch.calls[0]
    if (!first?.permissionPreset) throw new Error("权限批次缺少预设")
    if (
      batch.calls.some(
        (request) =>
          request.permissionPreset !== first.permissionPreset ||
          request.permissionReviewMode !== first.permissionReviewMode,
      )
    )
      throw new Error("同一权限批次的预设和审核方式必须一致")
    return this.#policyPermissionManager.authorizeBatch(
      batch,
      {
        workspaceRoot: this.#cwd,
        homeDirectory: homedir(),
        sensitivePaths: [
          ".env",
          ".npmrc",
          ".pypirc",
          "credentials",
          "credentials.json",
          "id_rsa",
          "id_ed25519",
          ".ssh",
          ".git",
          ".aizen",
          "auth.json",
        ],
        shell:
          first.environment &&
          typeof first.environment === "object" &&
          !Array.isArray(first.environment) &&
          typeof first.environment.shell === "string"
            ? first.environment.shell
            : "unknown",
        platform: process.platform,
      },
      builtinPermissionPolicies[first.permissionPreset === "custom" ? "edit" : first.permissionPreset],
      first.permissionReviewMode ?? "manual",
      signal,
    )
  }

  #requestPermissionAnswer(batch: HumanReviewBatchRequest, signal?: AbortSignal): Promise<HumanReviewBatchDecision> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#pendingPermissionAnswers.delete(batch.batchId)
        this.#snapshot.pendingPermissionRequests = (this.#snapshot.pendingPermissionRequests ?? []).filter(
          (item) => item.batchId !== batch.batchId,
        )
        this.#notify()
        reject(signal?.reason instanceof Error ? signal.reason : new Error("权限审核已取消"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.#pendingPermissionAnswers.set(batch.batchId, {
        resolve: (decision) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(decision)
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort)
          reject(error)
        },
      })
      this.#snapshot.pendingPermissionRequests = [
        ...(this.#snapshot.pendingPermissionRequests ?? []).filter((item) => item.batchId !== batch.batchId),
        ...batch.requests,
      ]
      for (const request of batch.requests) {
        for (const listener of this.#listeners)
          listener({ type: "permission_request", request: structuredClone(request) })
      }
      this.#notify()
    })
  }

  #answerPermissionBatch(batchId: string, answers: HumanReviewBatchDecision["answers"]): void {
    const pending = this.#pendingPermissionAnswers.get(batchId)
    if (!pending) throw new Error("当前没有等待答复的工具权限批次")
    const requests = (this.#snapshot.pendingPermissionRequests ?? []).filter((request) => request.batchId === batchId)
    const answerIds = new Set(answers.map((answer) => answer.requestId))
    if (answers.length !== requests.length || requests.some((request) => !answerIds.has(request.requestId)))
      throw new Error("必须一次答复权限批次中的全部请求")
    this.#pendingPermissionAnswers.delete(batchId)
    this.#snapshot.pendingPermissionRequests = (this.#snapshot.pendingPermissionRequests ?? []).filter(
      (request) => request.batchId !== batchId,
    )
    pending.resolve({
      batchId,
      answers: answers.map((answer) => {
        const reason = answer.type === "deny" ? answer.reason?.trim() : undefined
        return answer.type === "approve"
          ? answer
          : { requestId: answer.requestId, type: "deny" as const, ...(reason ? { reason } : {}) }
      }),
    })
  }

  #cancelPendingPermissions(message: string): void {
    for (const pending of this.#pendingPermissionAnswers.values()) pending.reject(new Error(message))
    this.#pendingPermissionAnswers.clear()
    this.#snapshot.pendingPermissionRequests = []
  }

  async #recordPermissionAudit(event: PermissionAuditEvent): Promise<void> {
    if (event.type === "aiReviewed") {
      if (event.error) {
        this.#snapshot.permissionReviewError = event.error
        this.#reportError(event.error)
      } else delete this.#snapshot.permissionReviewError
      this.#notify()
    }
    const sessionId = this.#snapshot.currentSessionId
    const turnId = this.#currentTurnId
    if (!sessionId || !turnId) return
    const request = "request" in event ? event.request : undefined
    const batch = "batch" in event ? event.batch : undefined
    const toolCallId =
      request?.toolCallId ??
      (batch && "calls" in batch ? batch.calls[0]?.toolCallId : batch?.authorizations[0]?.toolCallId) ??
      "batch"
    const record: SessionRecord = {
      kind: "tool_permission",
      recordId: crypto.randomUUID(),
      turnId,
      at: event.at,
      toolCallId,
      event: sanitizePermissionAuditPayload(JSON.parse(JSON.stringify(event)), request?.sensitiveFields),
    }
    await this.#appendRecord(sessionId, record)
  }

  async #recordPermissionExecution(event: PiPermissionExecutionEvent): Promise<void> {
    const sessionId = this.#snapshot.currentSessionId
    const turnId = this.#currentTurnId
    if (!sessionId || !turnId) return
    await this.#appendRecord(sessionId, {
      kind: "tool_permission",
      recordId: crypto.randomUUID(),
      turnId,
      at: event.at,
      toolCallId: event.request.toolCallId,
      event: sanitizePermissionAuditPayload(JSON.parse(JSON.stringify(event)), event.request.sensitiveFields),
    })
  }

  #handlePiEvent(event: PiPortEvent): void {
    if (event.type === "auth_prompt") {
      for (const listener of this.#listeners)
        listener({
          type: "auth_prompt",
          promptId: event.promptId,
          promptType: event.promptType,
          message: event.message,
          ...(event.placeholder ? { placeholder: event.placeholder } : {}),
          ...(event.options ? { options: event.options.map((option) => ({ ...option })) } : {}),
        })
      return
    }
    if (event.type === "auth_notice") {
      for (const listener of this.#listeners)
        listener({
          type: "auth_notice",
          message: event.message,
          ...(event.links ? { links: event.links.map((link) => ({ ...link })) } : {}),
          ...(event.deviceCode ? { deviceCode: { ...event.deviceCode } } : {}),
        })
      return
    }
    if (event.type === "text_delta") this.#snapshot.streamingText += event.delta
    if (event.type === "thinking_delta") this.#snapshot.streamingThinking += event.delta
    if (event.type === "usage_updated") {
      if (this.#snapshot.responseMetrics) this.#snapshot.responseMetrics.outputTokens = event.outputTokens
      const previousUsed = this.#snapshot.contextUsage?.used ?? 0
      const used =
        event.contextTokens === undefined || (event.contextTokens === 0 && previousUsed > 0)
          ? previousUsed
          : event.contextTokens
      const total = this.#snapshot.currentModel?.contextWindow
      this.#snapshot.contextUsage = total === undefined ? { used } : { used, total }
    }
    if (event.type === "tool_started")
      this.#snapshot.activeTools.push({ callId: event.callId, name: event.name, arguments: event.arguments })
    if (event.type === "tool_updated") {
      const tool = this.#snapshot.activeTools.find((item) => item.callId === event.callId)
      if (tool) tool.outputPreview = event.output
    }
    if (event.type === "tool_finished") {
      const tool = this.#snapshot.activeTools.find((item) => item.callId === event.callId)
      if (tool) {
        tool.isFinished = true
        tool.isError = event.isError
      }
    }
    if (event.type === "message" && this.#currentTurnId && this.#snapshot.currentSessionId) {
      const record: SessionRecord = {
        kind: "message",
        recordId: event.recordId,
        turnId: this.#currentTurnId,
        at: new Date().toISOString(),
        message: event.record,
      }
      const sessionId = this.#snapshot.currentSessionId
      this.#enqueueRecord(sessionId, record)
      this.#snapshot.transcript.push({ type: "message", turnId: this.#currentTurnId, message: event.record })
      // 提取为局部常量以便对消息角色做判别式收窄。
      const messageRecord = event.record
      if (messageRecord.role === "assistant") {
        if (this.#hasContextUsage(messageRecord))
          this.#snapshot.contextUsage = this.#contextUsageFromAssistant(messageRecord)
        if (this.#snapshot.responseMetrics) this.#snapshot.responseMetrics.outputTokens = messageRecord.usage.output
        // 归档即清空：已完成的思考/文本段进入历史后不再于 footer 输出区占位。
        this.#snapshot.streamingText = ""
        this.#snapshot.streamingThinking = ""
      } else if (messageRecord.role === "tool") {
        // 工具结果归档：从 footer 输出区移除该工具行，历史工具组块成为唯一展示。
        this.#snapshot.activeTools = this.#snapshot.activeTools.filter((tool) => tool.callId !== messageRecord.callId)
      }
    }
    if (event.type === "compaction" && this.#snapshot.currentSessionId) {
      const record: SessionRecord = {
        kind: "compaction",
        recordId: crypto.randomUUID(),
        at: new Date().toISOString(),
        summary: event.summary,
        firstKeptRecordId: event.firstKeptRecordId,
        tokensBefore: event.tokensBefore,
      }
      const sessionId = this.#snapshot.currentSessionId
      this.#enqueueRecord(sessionId, record)
    }
    // 流式/工具/消息事件的快照通知按窗口合并：同一窗口内到达的一批 delta
    // 只克隆一次快照并通知一次，避免高频 delta 下每次事件都全量克隆+重算。
    this.#scheduleSnapshotNotify()
  }

  async #appendRecord(sessionId: string, record: SessionRecord): Promise<void> {
    const operation = this.#writeQueue.then(async () => {
      if (this.#writeError) throw this.#writeError
      await this.#store.append(sessionId, record)
      if (this.#snapshot.currentSessionId === sessionId) this.#records.push(record)
    })
    this.#writeQueue = operation.catch((error) => {
      const actual = error instanceof Error ? error : new Error(String(error))
      if (actual instanceof InvalidSessionRecordError) {
        // 单条记录本身非法：跳过并告警，不锁死会话，调用方也无需感知。
        this.#reportError(`已跳过无效的会话记录：${actual.message}`)
        return
      }
      this.#markWriteFailure(actual)
      this.#notify()
    })
    await operation.catch((error) => {
      const actual = error instanceof Error ? error : new Error(String(error))
      if (actual instanceof InvalidSessionRecordError) return
      throw actual
    })
  }

  #enqueueRecord(sessionId: string, record: SessionRecord): void {
    void this.#appendRecord(sessionId, record).catch(() => {})
  }

  #firstUserMessage(): string | undefined {
    for (const record of this.#records) {
      if (record.kind !== "turn_started") continue
      const text = record.items
        .filter((item) => item.source === "user" && item.role === "user")
        .flatMap((item) => item.parts)
        .filter((part) => part.kind === "text")
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join("\n")
      if (text) return text
    }
    return undefined
  }

  #startSessionNaming(sessionId: string, firstUserMessage: string): void {
    const model = this.#snapshot.preferences.agents.sessionNaming.model
    if (!model || this.#sessionNamingAttempted || this.#records.some((record) => record.kind === "session_renamed"))
      return
    this.#sessionNamingAttempted = true
    const controller = new AbortController()
    this.#sessionNamingAbort = controller
    const task = this.#pi
      .generateSessionTitle({ model, firstUserMessage, signal: controller.signal })
      .then(async (name) => {
        await this.#writeQueue
        if (this.#snapshot.currentSessionId !== sessionId) return
        if (this.#records.some((record) => record.kind === "session_renamed")) return
        const record: SessionRecord = {
          kind: "session_renamed",
          recordId: crypto.randomUUID(),
          at: new Date().toISOString(),
          name,
        }
        await this.#appendRecord(sessionId, record)
        this.#snapshot.currentSessionName = name
        this.#snapshot.sessions = await this.#store.list()
        this.#reportStoreWarnings()
        this.#notify()
      })
      .catch((error) => {
        if (controller.signal.aborted || this.#disposed) return
        this.#reportError(`会话自动命名失败：${error instanceof Error ? error.message : String(error)}`)
        this.#notify()
      })
      .finally(() => {
        if (this.#sessionNamingAbort === controller) this.#sessionNamingAbort = undefined
        if (this.#sessionNamingTask === task) this.#sessionNamingTask = undefined
      })
    this.#sessionNamingTask = task
  }

  #reportPreferenceWarnings(): void {
    const warnings = this.#preferencesStore?.takeWarnings() ?? []
    if (warnings.length > 0) this.#reportError(`preferences.json 配置警告：${warnings.join("；")}`)
  }

  #reportStoreWarnings(): void {
    const warnings = this.#store.takeWarnings()
    if (warnings.length > 0) this.#reportError(warnings.join("；"))
  }

  #markWriteFailure(error: Error): void {
    this.#writeError = error
    this.#reportError(`保存会话失败：${error.message}`)
  }

  #reportError(message: string): void {
    this.#errors.report(message)
    this.#syncVisibleError()
  }

  #syncVisibleError(): void {
    const visible = this.#errors.visible()
    if (visible) this.#snapshot.lastError = visible.message
    else delete this.#snapshot.lastError
  }

  #hasContextUsage(message: AssistantMessage): boolean {
    return message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite > 0
  }

  #contextUsageFromAssistant(message: AssistantMessage) {
    const total = this.#snapshot.currentModel?.contextWindow
    const used = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite
    return total === undefined ? { used } : { used, total }
  }

  #contextUsageFromRecords() {
    const assistant = [...this.#records]
      .reverse()
      .find(
        (record): record is SessionRecord & { message: AssistantMessage } =>
          record.kind === "message" && record.message.role === "assistant" && this.#hasContextUsage(record.message),
      )
    const total = this.#snapshot.currentModel?.contextWindow
    const used = assistant ? this.#contextUsageFromAssistant(assistant.message).used : 0
    return total === undefined ? { used } : { used, total }
  }

  #elapsedSeconds(): number {
    const startedAt = this.#snapshot.responseMetrics?.startedAt
    return startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0
  }

  #startResponseTimer(): void {
    this.#stopResponseTimer()
    this.#responseTimer = setInterval(() => {
      if (!this.#snapshot.responseMetrics) return
      const elapsedSeconds = this.#elapsedSeconds()
      if (this.#snapshot.responseMetrics.elapsedSeconds === elapsedSeconds) return
      this.#snapshot.responseMetrics.elapsedSeconds = elapsedSeconds
      this.#notify()
    }, 1000)
  }

  #stopResponseTimer(): void {
    if (!this.#responseTimer) return
    clearInterval(this.#responseTimer)
    this.#responseTimer = undefined
  }

  /** 合并窗口内的流式/工具快照通知；窗口长度取一帧（约 16ms），视觉上仍平滑。 */
  #scheduleSnapshotNotify(): void {
    if (this.#snapshotNotifyScheduled || this.#disposed) return
    this.#snapshotNotifyScheduled = true
    setTimeout(() => {
      this.#snapshotNotifyScheduled = false
      if (this.#disposed) return
      this.#notify()
    }, 16)
  }

  #notify(): void {
    const snapshot = this.getSnapshot()
    for (const listener of this.#listeners) listener({ type: "snapshot", snapshot })
  }
}
