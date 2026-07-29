import { type AppPreferencesStore, defaultAppPreferences, parseAppPreferences } from "./app-preferences-store.ts"
import { CoreErrorQueue } from "./error-queue.ts"
import type { ModelConfigStore } from "./model-config-store.ts"
import type { PiPort, PiPortEvent } from "./pi-port.ts"
import type {
  AssistantMessage,
  ModelReference,
  SessionRecord,
  TurnFinishedRecord,
  TurnInputItem,
  TurnStartedRecord,
  ViewId,
} from "./session-format.ts"
import type { SessionStore } from "./session-store.ts"
import {
  type CoreCommand,
  type CoreCommandResult,
  type CoreEvent,
  type CorePort,
  type CoreSnapshot,
  recordsToTranscript,
} from "./types.ts"
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
  extraMessages?: ExtraMessageProvider
  modelConfigStore?: ModelConfigStore
  preferencesStore?: AppPreferencesStore
}

function sessionModel(model: ModelReference): ModelReference {
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    api: model.api,
    ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
  }
}

export class AizenCore implements CorePort {
  readonly #cwd: string
  readonly #store: SessionStore
  readonly #pi: PiPort
  readonly #views: ViewStore | undefined
  readonly #extraMessages: ExtraMessageProvider
  readonly #modelConfigStore: ModelConfigStore | undefined
  readonly #preferencesStore: AppPreferencesStore | undefined
  readonly #listeners = new Set<(event: CoreEvent) => void>()
  readonly #unsubscribePi: () => void
  #snapshot: CoreSnapshot
  #records: SessionRecord[] = []
  #writeQueue = Promise.resolve()
  #writeError: Error | undefined
  readonly #errors = new CoreErrorQueue()
  #currentTurnId: string | undefined
  #responseTimer: ReturnType<typeof setInterval> | undefined
  #abortRequested = false
  #runtimeReady = false
  #preferencesLoaded = false
  #disposed = false

  constructor(options: AizenCoreOptions) {
    this.#cwd = options.cwd
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
      transcript: [],
      activeTools: [],
      streamingText: "",
      streamingThinking: "",
    }
    this.#views = options.views
    this.#extraMessages = options.extraMessages ?? (async () => [])
    this.#modelConfigStore = options.modelConfigStore
    this.#preferencesStore = options.preferencesStore
    this.#unsubscribePi = this.#pi.subscribe((event) => this.#handlePiEvent(event))
  }

  getSnapshot(): CoreSnapshot {
    return structuredClone(this.#snapshot)
  }

  subscribe(listener: (event: CoreEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async dispatch(command: CoreCommand): Promise<CoreCommandResult> {
    if (this.#disposed)
      return { ok: false, error: { code: "CORE_DISPOSED", message: "核心已经关闭", severity: "fatal" } }
    try {
      this.#clearError()
      if (
        command.type !== "abort" &&
        command.type !== "answer_auth_prompt" &&
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
          if (
            this.#snapshot.currentModel?.providerId === command.providerId &&
            this.#snapshot.currentModel.modelId === command.model.id
          )
            throw new Error("不能修改当前会话正在使用的模型，请先切换模型")
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
        case "create_session":
          await this.#createSession(command.model, command.viewId)
          break
        case "open_session":
          await this.#openSession(command.sessionId)
          break
        case "rename_session":
          await this.#renameSession(command.sessionId, command.name)
          break
        case "send_prompt":
          await this.#sendPrompt(command.text)
          break
        case "abort":
          if (this.#snapshot.status === "running") {
            this.#abortRequested = true
            this.#snapshot.status = "aborting"
            this.#notify()
            await this.#pi.abort()
          }
          break
        case "set_view":
          await this.#setView(command.viewId)
          break
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
      return { ok: false, error: { code: "COMMAND_FAILED", message, severity: "error" } }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    let failure: unknown
    try {
      if (this.#snapshot.status === "running" || this.#snapshot.status === "aborting") await this.#pi.abort()
    } catch (error) {
      failure = error
    } finally {
      this.#stopResponseTimer()
      try {
        await this.#writeQueue
        await this.#store.flush()
      } catch (error) {
        failure ??= error
      } finally {
        this.#unsubscribePi()
        try {
          await this.#pi.dispose()
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
    return this.#preferencesStore ? this.#preferencesStore.read() : structuredClone(this.#snapshot.preferences)
  }

  async #writePreferences(preferences: CoreSnapshot["preferences"]): Promise<void> {
    if (this.#preferencesStore) await this.#preferencesStore.write(preferences)
    this.#snapshot.preferences = preferences
    this.#preferencesLoaded = true
  }

  async #rememberSessionDefaults(model: ModelReference, viewId: ViewId): Promise<void> {
    if (!this.#preferencesLoaded) {
      this.#snapshot.preferences = await this.#readPreferences()
      this.#preferencesLoaded = true
    }
    await this.#writePreferences({
      ...this.#snapshot.preferences,
      newSession: { model: sessionModel(model), viewId },
    })
  }

  #requireModelConfigStore(): ModelConfigStore {
    if (!this.#modelConfigStore) throw new Error("当前运行模式不支持编辑模型配置")
    return this.#modelConfigStore
  }

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
  }

  async #createSession(model: ModelReference, viewId: ViewId): Promise<void> {
    const sessionId = await this.#store.suggestId()
    const at = new Date().toISOString()
    const view = await this.#resolveView(viewId)
    const actualModel = await this.#pi.create({ cwd: this.#cwd, model, view })
    await this.#store.create({ sessionId, cwd: this.#cwd, createdAt: at })
    const records: SessionRecord[] = [
      { kind: "model_changed", recordId: crypto.randomUUID(), at, model: sessionModel(actualModel) },
      { kind: "view_changed", recordId: crypto.randomUUID(), at, viewId },
    ]
    for (const record of records) await this.#store.append(sessionId, record)
    this.#records = records
    this.#writeError = undefined
    this.#snapshot.currentSessionId = sessionId
    this.#snapshot.currentSessionName = ""
    this.#runtimeReady = true
    this.#snapshot.currentModel = actualModel
    this.#snapshot.contextUsage = this.#contextUsageFromRecords()
    this.#snapshot.currentViewId = viewId
    this.#snapshot.transcript = []
    this.#snapshot.streamingText = ""
    this.#snapshot.streamingThinking = ""
    delete this.#snapshot.responseMetrics
    this.#snapshot.contextUsage = this.#contextUsageFromRecords()
    this.#clearError()
    this.#snapshot.sessions = await this.#store.list()
    this.#reportStoreWarnings()
    await this.#rememberSessionDefaults(actualModel, viewId)
  }

  async #openSession(sessionId: string): Promise<void> {
    const loaded = await this.#store.read(sessionId)
    if (loaded.header.cwd !== this.#cwd) throw new Error("该会话不属于当前工作目录")
    const modelRecord = [...loaded.records].reverse().find((record) => record.kind === "model_changed")
    const viewRecord = [...loaded.records].reverse().find((record) => record.kind === "view_changed")
    if (modelRecord?.kind !== "model_changed") throw new Error("会话没有模型记录")
    if (viewRecord?.kind !== "view_changed") throw new Error("会话没有视图记录")
    const view = await this.#resolveView(viewRecord.viewId).catch((error) => {
      this.#runtimeReady = false
      this.#reportError(error instanceof Error ? error.message : String(error))
      return undefined
    })
    const actualModel = view
      ? await this.#pi.restore({
          cwd: this.#cwd,
          model: modelRecord.model,
          view,
          records: loaded.records,
        })
      : modelRecord.model
    this.#runtimeReady = view !== undefined
    this.#records = loaded.records
    this.#writeError = undefined
    this.#snapshot.currentSessionId = sessionId
    const renamedRecord = [...loaded.records].reverse().find((record) => record.kind === "session_renamed")
    this.#snapshot.currentSessionName = renamedRecord?.kind === "session_renamed" ? renamedRecord.name : ""
    this.#snapshot.currentModel = actualModel
    this.#snapshot.contextUsage = this.#contextUsageFromRecords()
    this.#snapshot.currentViewId = viewRecord.viewId
    this.#snapshot.transcript = recordsToTranscript(loaded.records)
    this.#snapshot.streamingText = ""
    this.#snapshot.streamingThinking = ""
    delete this.#snapshot.responseMetrics
    if (loaded.warnings.length > 0) this.#reportError(loaded.warnings.join("；"))
    else if (this.#runtimeReady) this.#clearError()
    await this.#rememberSessionDefaults(actualModel, viewRecord.viewId)
  }

  async #renameSession(sessionId: string, name: string): Promise<void> {
    const normalizedName = name.trim()
    const loaded = await this.#store.read(sessionId)
    if (loaded.header.cwd !== this.#cwd) throw new Error("该会话不属于当前工作目录")
    const record: SessionRecord = {
      kind: "session_renamed",
      recordId: crypto.randomUUID(),
      at: new Date().toISOString(),
      name: normalizedName,
    }
    await this.#store.append(sessionId, record)
    if (this.#snapshot.currentSessionId === sessionId) {
      this.#records.push(record)
      this.#snapshot.currentSessionName = normalizedName
    }
    this.#snapshot.sessions = await this.#store.list()
    this.#reportStoreWarnings()
  }

  async #sendPrompt(text: string): Promise<void> {
    const sessionId = this.#snapshot.currentSessionId
    const viewId = this.#snapshot.currentViewId
    if (!sessionId || viewId === undefined) throw new Error("请先新建或恢复会话")
    if (!text.trim()) throw new Error("消息不能为空")
    if (this.#writeError) throw new Error(`会话持久化异常，请重新打开会话：${this.#writeError.message}`)
    if (!this.#runtimeReady) throw new Error("当前视图已失效，请先使用 /view 切换视图")
    const view = await this.#resolveView(viewId)
    await this.#pi.refreshView(view)
    const turnId = crypto.randomUUID()
    const extraItems = await this.#extraMessages({ cwd: this.#cwd, sessionId, turnId, viewId, text })
    const items: TurnInputItem[] = [
      ...extraItems,
      { source: "user", role: "user", useLater: true, parts: [{ kind: "text", text }] },
    ]
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
    let outcome: TurnFinishedRecord["outcome"] = "completed"
    let error: TurnFinishedRecord["error"]
    try {
      await this.#pi.prompt({ recordId: started.recordId, turnId, viewId, items: started.items })
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

  async #setView(viewId: ViewId): Promise<void> {
    const sessionId = this.#snapshot.currentSessionId
    if (!sessionId) throw new Error("请先新建或恢复会话")
    const view = await this.#resolveView(viewId)
    const model = this.#snapshot.currentModel
    if (!model) throw new Error("当前会话没有模型")
    const actual = await this.#pi.restore({ cwd: this.#cwd, model, view, records: this.#records })
    const record: SessionRecord = {
      kind: "view_changed",
      recordId: crypto.randomUUID(),
      at: new Date().toISOString(),
      viewId,
    }
    await this.#store.append(sessionId, record)
    this.#records.push(record)
    this.#snapshot.currentViewId = viewId
    this.#snapshot.currentModel = actual
    this.#runtimeReady = true
    await this.#rememberSessionDefaults(actual, viewId)
  }

  async #resolveView(viewId: ViewId) {
    if (viewId === null) return { viewId: null }
    if (!this.#views) return { viewId, directory: this.#cwd }
    const view = await this.#views.resolve(viewId)
    return { viewId, directory: view.directory }
  }

  async #setModel(model: ModelReference): Promise<void> {
    const sessionId = this.#snapshot.currentSessionId
    if (!sessionId) throw new Error("请先新建或恢复会话")
    const actual = await this.#pi.setModel(model)
    const record: SessionRecord = {
      kind: "model_changed",
      recordId: crypto.randomUUID(),
      at: new Date().toISOString(),
      model: sessionModel(actual),
    }
    await this.#store.append(sessionId, record)
    this.#records.push(record)
    this.#snapshot.currentModel = actual
    this.#snapshot.contextUsage = this.#contextUsageFromRecords()
    await this.#rememberSessionDefaults(actual, this.#snapshot.currentViewId ?? null)
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
      if (event.record.role === "assistant") {
        if (this.#hasContextUsage(event.record))
          this.#snapshot.contextUsage = this.#contextUsageFromAssistant(event.record)
        if (this.#snapshot.responseMetrics) this.#snapshot.responseMetrics.outputTokens = event.record.usage.output
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
    this.#notify()
  }

  #enqueueRecord(sessionId: string, record: SessionRecord): void {
    const operation = this.#writeQueue.then(async () => {
      if (this.#writeError) return
      await this.#store.append(sessionId, record)
      this.#records.push(record)
    })
    this.#writeQueue = operation.catch((error) => {
      const actual = error instanceof Error ? error : new Error(String(error))
      this.#markWriteFailure(actual)
      this.#notify()
    })
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

  #clearError(): void {
    this.#errors.clearVisible()
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

  #notify(): void {
    const snapshot = this.getSnapshot()
    for (const listener of this.#listeners) listener({ type: "snapshot", snapshot })
  }
}
