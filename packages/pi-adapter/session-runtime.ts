import type { AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core"
import {
  type Api,
  type AuthPrompt,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  isContextOverflow,
  type Model,
  type ModelThinkingLevel,
  type AssistantMessage as PiAssistantMessage,
  type UserMessage as PiUserMessage,
} from "@earendil-works/pi-ai"
import { builtinModels } from "@earendil-works/pi-ai/providers/all"
import {
  type AgentSession,
  createAgentSession,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_COMPACTION_SETTINGS,
  DefaultResourceLoader,
  getShellConfig,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  shouldCompact,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { ModelConfigStore, type ModelThinkingConfig } from "../core/model-config-store.ts"
import type {
  AuthProviderOption,
  ModelOption,
  ModelRuntimeInfo,
  PiCreateInput,
  PiPermissionBatchHandler,
  PiPermissionExecutionHandler,
  PiPermissionHandler,
  PiPort,
  PiPortEvent,
  PiPromptInput,
  PiProviderOption,
  PiRestoreInput,
  PiSessionTitleInput,
  ProviderAuthType,
  ResolvedViewResources,
} from "../core/pi-port.ts"
import { PiModelRuntimeError } from "../core/pi-port.ts"
import { PiProviderStore } from "../core/pi-provider-store.ts"
import type { JsonValue, ModelReference, SessionRecord } from "../core/session-format.ts"
import { projectVisibleSessionRecords, workingDirectoryChangeText } from "../core/session-projection.ts"
import type { ToolAuthorization, ToolPermissionRequest } from "../core/tool-permissions/types.ts"
import type { AizenToolRegistration } from "../core/tool-registry.ts"
import { coreMessageToPi, piMessageToCore, turnInputToPi } from "./message-mapper.ts"
import { permissionFailureMessage } from "./permission-failure.ts"
import { PiPermissionReviewer } from "./permission-reviewer.ts"
import { PiCredentialStore, PiModelsCacheStore } from "./pi-stores.ts"
import { PiProviderRuntime } from "./provider-runtime.ts"
import { generateSessionTitle } from "./session-title-generator.ts"
import { normalizeToolFailure } from "./tool-failure.ts"

export type PiSessionRuntimeOptions = {
  authPath: string
  customProvidersPath: string | null
  piProvidersPath?: string
  piModelsCachePath?: string
}

const piThinkingLevels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const

type RuntimeThinkingConfig = ModelThinkingConfig | null | undefined

type PermissionBatchState = {
  batchId: string
  requests: Map<string, ToolPermissionRequest>
  pending: Map<
    string,
    {
      resolve: (authorization: ToolAuthorization) => void
      reject: (error: Error) => void
    }
  >
  signal?: AbortSignal
  dispatchQueued: boolean
}

/**
 * 为当前内存会话复制模型配置，避免重新读取 custom-providers.json 时改动正在使用的对象。
 * 请求开始后，pi 会把该对象、思考档位、消息和工具保存在本次请求使用的内存状态中。
 */
function runtimeModel(model: Model<Api>, config: RuntimeThinkingConfig, baseUrl?: string): Model<Api> {
  const actualModel = { ...model, ...(baseUrl === undefined ? {} : { baseUrl }) }
  if (config === undefined) return actualModel
  if (config === null) {
    const { thinkingLevelMap: _thinkingLevelMap, ...plainModel } = actualModel
    return { ...plainModel, reasoning: false }
  }
  return {
    ...actualModel,
    reasoning: true,
    thinkingLevelMap: {
      off: config.disableThinkingLevel === undefined ? null : config.disableThinkingLevel,
      ...Object.fromEntries(piThinkingLevels.map((level, index) => [level, config.thinkingLevels[index] ?? null])),
    },
  }
}

function internalThinkingLevel(
  model: Model<Api>,
  level: string | undefined,
  config: RuntimeThinkingConfig,
): ThinkingLevel {
  if (config === null) {
    if (level !== undefined) throw new Error(`模型 ${model.provider}/${model.id} 未配置思考档位`)
    return "off"
  }
  if (config === undefined) {
    if (!model.reasoning) {
      if (level !== undefined) throw new Error(`模型 ${model.provider}/${model.id} 不支持思考`)
      return "off"
    }
    if (!level || !getSupportedThinkingLevels(model).includes(level as ModelThinkingLevel))
      throw new Error(`模型 ${model.provider}/${model.id} 不支持思考档位：${level ?? "未设置"}`)
    return level as ThinkingLevel
  }
  if (level === config.disableThinkingLevel) return "off"
  const index = config.thinkingLevels.indexOf(level ?? "")
  if (index < 0) throw new Error(`模型 ${model.provider}/${model.id} 不支持思考档位：${level ?? "未设置"}`)
  return piThinkingLevels[index] as ThinkingLevel
}

function modelReference(model: Model<Api>, thinkingLevel: ThinkingLevel, config: RuntimeThinkingConfig) {
  const externalLevel =
    config === null || (!model.reasoning && config === undefined)
      ? undefined
      : config === undefined
        ? thinkingLevel
        : thinkingLevel === "off"
          ? config.disableThinkingLevel
          : config.thinkingLevels[piThinkingLevels.indexOf(thinkingLevel as (typeof piThinkingLevels)[number])]
  return {
    providerId: model.provider,
    modelId: model.id,
    ...(externalLevel === undefined ? {} : { thinkingLevel: externalLevel }),
    contextWindow: model.contextWindow,
  }
}

function createViewLoader(
  cwd: string,
  view: ResolvedViewResources,
  settingsManager: SettingsManager,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalSkillPaths: view.skillPaths,
    systemPromptOverride: () => view.systemPrompt,
    agentsFilesOverride: () => ({ agentsFiles: view.agentsFiles }),
  })
}

class MutableViewLoader implements ResourceLoader {
  #current: ResourceLoader

  constructor(loader: ResourceLoader) {
    this.#current = loader
  }

  replace(loader: ResourceLoader): void {
    this.#current = loader
  }

  getExtensions = () => this.#current.getExtensions()
  getSkills = () => this.#current.getSkills()
  getPrompts = () => this.#current.getPrompts()
  getThemes = () => this.#current.getThemes()
  getAgentsFiles = () => this.#current.getAgentsFiles()
  getSystemPrompt = () => this.#current.getSystemPrompt()
  getAppendSystemPrompt = () => this.#current.getAppendSystemPrompt()
  extendResources = (paths: Parameters<ResourceLoader["extendResources"]>[0]) => this.#current.extendResources(paths)
  reload = (options?: Parameters<ResourceLoader["reload"]>[0]) => this.#current.reload(options)
}

function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return ""
  return result.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function auditedTools(
  cwd: string,
  authorize: (input: {
    callId: string
    name: string
    arguments: JsonValue
    declaredIntent: string
    signal?: AbortSignal
  }) => Promise<Extract<ToolAuthorization, { type: "allow" }>>,
  register: (input: {
    callId: string
    name: string
    arguments: JsonValue
    declaredIntent: string
    signal?: AbortSignal
  }) => void,
  activePrompt: () => PiPromptInput | undefined,
  recordExecution: PiPermissionExecutionHandler | undefined,
): ToolDefinition[] {
  const declaredIntentSchema = Type.String({
    minLength: 1,
    maxLength: 50,
    description: "用不超过 50 个字符的一句话说明本次工具调用的目的，供用户阅读和审计",
  })
  return [
    createReadTool(cwd),
    createBashTool(cwd),
    createEditTool(cwd),
    createWriteTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ].map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: Type.Object({ ...tool.parameters.properties, declaredIntent: declaredIntentSchema }),
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    async execute(callId, params, signal, onUpdate) {
      const { declaredIntent, ...actualParams } = params as Record<string, unknown> & { declaredIntent: string }
      const call = {
        callId,
        name: tool.name,
        arguments: jsonValue(actualParams),
        declaredIntent,
        ...(signal ? { signal } : {}),
      }
      register(call)
      const authorization = await authorize(call)
      const prompt = activePrompt()
      const request = prompt?.sessionId
        ? {
            sessionId: prompt.sessionId,
            turnId: prompt.turnId,
            toolCallId: callId,
            toolName: tool.name,
            arguments: authorization.arguments,
            declaredIntent,
            cwd,
          }
        : undefined
      if (request)
        await recordExecution?.({
          phase: "executionStarted",
          request,
          authorization,
          at: new Date().toISOString(),
        })
      try {
        const result = await tool.execute(callId, authorization.arguments as never, signal, onUpdate)
        if (request)
          await recordExecution?.({
            phase: "executionFinished",
            request,
            authorization,
            isError: false,
            at: new Date().toISOString(),
          })
        return result
      } catch (error) {
        const normalized = normalizeToolFailure(tool.name, error, signal)
        if (request)
          await recordExecution?.({
            phase: "executionFinished",
            request,
            authorization,
            isError: true,
            error: normalized.message,
            at: new Date().toISOString(),
          })
        throw new Error(normalized.message)
      }
    },
  }))
}

function registeredTools(
  cwd: string,
  registrations: AizenToolRegistration[],
  authorize: Parameters<typeof auditedTools>[1],
  register: Parameters<typeof auditedTools>[2],
  activePrompt: () => PiPromptInput | undefined,
  recordExecution: PiPermissionExecutionHandler | undefined,
): ToolDefinition[] {
  const declaredIntentSchema = Type.String({
    minLength: 1,
    maxLength: 50,
    description: "用不超过 50 个字符的一句话说明本次工具调用的目的，供用户阅读和审计",
  })
  return registrations.map((registration) => {
    const schema = registration.descriptor.parameters
    if (!schema || typeof schema !== "object" || Array.isArray(schema) || schema.type !== "object")
      throw new Error(`工具 ${registration.descriptor.name} 的参数 Schema 顶层必须是 object`)
    const properties =
      schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? schema.properties
        : {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : []
    const parameters = {
      ...schema,
      properties: { ...properties, declaredIntent: declaredIntentSchema },
      required: [...new Set([...required, "declaredIntent"])],
    }
    return {
      name: registration.descriptor.name,
      label: registration.descriptor.label,
      description: registration.descriptor.description,
      parameters: parameters as never,
      ...(registration.descriptor.executionMode ? { executionMode: registration.descriptor.executionMode } : {}),
      async execute(callId, params, signal, onUpdate) {
        const source = params as Record<string, unknown> & { declaredIntent: string }
        const declaredIntent = source.declaredIntent
        const { declaredIntent: _declaredIntent, ...argumentsValue } = source
        const call = {
          callId,
          name: registration.descriptor.name,
          arguments: jsonValue(argumentsValue),
          declaredIntent,
          ...(signal ? { signal } : {}),
        }
        register(call)
        const authorization = await authorize(call)
        const prompt = activePrompt()
        const request = prompt?.sessionId
          ? {
              sessionId: prompt.sessionId,
              turnId: prompt.turnId,
              toolCallId: callId,
              toolName: registration.descriptor.name,
              arguments: authorization.arguments,
              declaredIntent,
              cwd,
            }
          : undefined
        if (request)
          await recordExecution?.({
            phase: "executionStarted",
            request,
            authorization,
            at: new Date().toISOString(),
          })
        try {
          const result = await registration.execute({
            toolCallId: callId,
            cwd,
            arguments: authorization.arguments,
            ...(signal ? { signal } : {}),
            ...(onUpdate
              ? {
                  onUpdate: (update) =>
                    onUpdate({
                      content: update.content.map((item) =>
                        item.type === "text"
                          ? { type: "text" as const, text: item.text }
                          : { type: "image" as const, data: item.data, mimeType: item.mimeType },
                      ),
                      details: update.details,
                    } as never),
                }
              : {}),
          })
          if (request)
            await recordExecution?.({
              phase: "executionFinished",
              request,
              authorization,
              isError: false,
              at: new Date().toISOString(),
            })
          return result as never
        } catch (error) {
          const normalized = normalizeToolFailure(registration.descriptor.name, error, signal)
          if (request)
            await recordExecution?.({
              phase: "executionFinished",
              request,
              authorization,
              isError: true,
              error: normalized.message,
              at: new Date().toISOString(),
            })
          throw new Error(normalized.message)
        }
      },
    }
  })
}

export class PiSessionRuntime implements PiPort {
  readonly #modelRuntime: ModelRuntime
  readonly #customProvidersPath: string | null
  readonly #piProviderRuntime: PiProviderRuntime | undefined
  readonly #piProviderStore: PiProviderStore | undefined
  readonly #listeners = new Set<(event: PiPortEvent) => void>()
  #thinkingConfigs = new Map<string, ModelThinkingConfig | null>()
  #modelBaseUrls = new Map<string, string>()
  #modelConfigError: Error | undefined
  #permissionBatchHandler: PiPermissionBatchHandler | undefined
  #toolRegistrations: AizenToolRegistration[] = []
  #permissionHandler: PiPermissionHandler | undefined
  #permissionBatch: PermissionBatchState | undefined
  #permissionExecutionHandler: PiPermissionExecutionHandler | undefined
  #activePromptInput: PiPromptInput | undefined
  #session: AgentSession | undefined
  #activePrompt: Promise<void> | undefined
  #activeCompaction: Promise<void> | undefined
  #unsubscribe: (() => void) | undefined
  #unsubscribeAgent: (() => void) | undefined
  #authAbortController: AbortController | undefined
  #authAnswers = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>()
  #entryRecordIds = new Map<string, string>()
  #recordEntries = new Map<string, string>()
  #viewLoader: MutableViewLoader | undefined
  #settingsManager: SettingsManager | undefined
  #cwd: string | undefined
  #contentStarts = new Map<number, number>()
  #contentTimings = new Map<number, { startedAt: number; finishedAt: number }>()
  #toolStarts = new Map<string, number>()
  #toolTimings = new Map<string, { startedAt: number; finishedAt: number }>()
  #toolBatchSequence = 0

  private constructor(
    modelRuntime: ModelRuntime,
    customProvidersPath: string | null,
    piProviderRuntime?: PiProviderRuntime,
    piProviderStore?: PiProviderStore,
  ) {
    this.#modelRuntime = modelRuntime
    this.#customProvidersPath = customProvidersPath
    this.#piProviderRuntime = piProviderRuntime
    this.#piProviderStore = piProviderStore
  }

  static async create(options: PiSessionRuntimeOptions): Promise<PiSessionRuntime> {
    let runtime!: PiSessionRuntime
    const modelRuntime = await ModelRuntime.create({
      credentials: new PiCredentialStore(options.authPath),
      modelsPath: options.customProvidersPath,
      ...(options.piModelsCachePath ? { modelsStore: new PiModelsCacheStore(options.piModelsCachePath) } : {}),
      allowModelNetwork: false,
    })
    const providerStore = options.piProvidersPath ? new PiProviderStore(options.piProvidersPath) : undefined
    const providerRuntime = providerStore
      ? new PiProviderRuntime(
          builtinModels({
            credentials: new PiCredentialStore(options.authPath),
            ...(options.piModelsCachePath ? { modelsStore: new PiModelsCacheStore(options.piModelsCachePath) } : {}),
          }),
          providerStore,
          (event) => runtime.#emit(event),
        )
      : undefined
    runtime = new PiSessionRuntime(modelRuntime, options.customProvidersPath, providerRuntime, providerStore)
    await runtime.#reloadModelConfigs()
    return runtime
  }

  async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.#modelRuntime.setRuntimeApiKey(providerId, apiKey)
  }

  /**
   * 测试和分发探针使用的运行时地址覆盖。空闲时同步当前 session；
   * 生成期间只保存给下次创建内存会话使用，不能改动正在请求的模型对象。
   */
  setModelBaseUrl(providerId: string, modelId: string, baseUrl: string): void {
    const model = this.#modelRuntime.getModel(providerId, modelId)
    if (!model) throw new Error(`找不到模型：${providerId}/${modelId}`)
    this.#modelBaseUrls.set(`${providerId}\0${modelId}`, baseUrl)
    const current = this.#session?.model
    if (!this.#activePrompt && this.#session?.isIdle && current?.provider === providerId && current.id === modelId)
      current.baseUrl = baseUrl
  }

  /**
   * 新建或恢复 pi 内存会话。先验证当前模型、档位和视图，再释放旧 session，
   * 避免模型缺失、档位失效和视图失效这类可修复错误先破坏旧 runtime。
   */
  async #start(input: PiCreateInput, records: SessionRecord[]): Promise<ModelRuntimeInfo> {
    if (this.#activePrompt || (this.#session && !this.#session.isIdle))
      throw new Error("生成或执行工具期间不能重建会话")
    const sourceModel = this.#modelRuntime.getModel(input.model.providerId, input.model.modelId)
    if (!sourceModel) throw new PiModelRuntimeError(`找不到模型：${input.model.providerId}/${input.model.modelId}`)
    if (
      this.#piProviderRuntime?.isBuiltin(input.model.providerId) &&
      !(await this.#piProviderRuntime.isEnabled(input.model.providerId))
    )
      throw new PiModelRuntimeError(`pi 供应商未启用：${input.model.providerId}`)
    const modelKey = `${sourceModel.provider}\0${sourceModel.id}`
    const thinkingConfig = this.#thinkingConfigs.get(modelKey)
    const model = runtimeModel(sourceModel, thinkingConfig, this.#modelBaseUrls.get(modelKey))
    let thinkingLevel: ThinkingLevel
    try {
      thinkingLevel = internalThinkingLevel(model, input.model.thinkingLevel, thinkingConfig)
    } catch (error) {
      throw new PiModelRuntimeError(error instanceof Error ? error.message : String(error))
    }
    const settingsManager = SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
        keepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
      },
      retry: { enabled: false },
    })
    const initialLoader = createViewLoader(input.cwd, input.view, settingsManager)
    await initialLoader.reload()
    this.#validateViewLoader(initialLoader, input.view.viewId)
    await this.#disposeSession()
    const resourceLoader = new MutableViewLoader(initialLoader)
    this.#viewLoader = resourceLoader
    this.#settingsManager = settingsManager
    this.#cwd = input.cwd
    const sessionManager = SessionManager.inMemory(input.cwd)
    this.#restoreEntries(sessionManager, records)
    const authorizeTool = async (call: {
      callId: string
      name: string
      arguments: JsonValue
      declaredIntent: string
      signal?: AbortSignal
    }) => {
      const prompt = this.#activePromptInput
      if (!prompt?.sessionId) throw new Error("工具权限处理器尚未初始化")
      const request: ToolPermissionRequest = {
        sessionId: prompt.sessionId,
        turnId: prompt.turnId,
        toolCallId: call.callId,
        toolName: call.name,
        arguments: call.arguments,
        declaredIntent: call.declaredIntent,
        cwd: input.cwd,
        ...(prompt.permissionPreset ? { permissionPreset: prompt.permissionPreset } : {}),
        ...(prompt.permissionReviewMode ? { permissionReviewMode: prompt.permissionReviewMode } : {}),
        ...(call.name === "bash" ? { environment: { shell: this.#shellKind() } } : {}),
      }
      if (!this.#permissionBatchHandler) {
        if (!this.#permissionHandler) throw new Error("工具权限处理器尚未初始化")
        return this.#requireAllowed(await this.#permissionHandler(request, call.signal))
      }
      const batch = this.#permissionBatch
      if (!batch) throw new Error("工具权限批次尚未开始收集")
      batch.requests.set(call.callId, request)
      return this.#requireAllowed(
        await new Promise<ToolAuthorization>((resolve, reject) => {
          batch.pending.set(call.callId, { resolve, reject })
        }),
      )
    }
    const registerTool = (call: {
      callId: string
      name: string
      arguments: JsonValue
      declaredIntent: string
      signal?: AbortSignal
    }) => this.#registerPermissionCall(input.cwd, call)
    const builtInTools = auditedTools(
      input.cwd,
      authorizeTool,
      registerTool,
      () => this.#activePromptInput,
      this.#permissionExecutionHandler,
    )
    const customTools = registeredTools(
      input.cwd,
      this.#toolRegistrations,
      authorizeTool,
      registerTool,
      () => this.#activePromptInput,
      this.#permissionExecutionHandler,
    )
    const { session } = await createAgentSession({
      cwd: input.cwd,
      modelRuntime: this.#modelRuntime,
      model,
      thinkingLevel,
      tools: [...builtInTools.map((tool) => tool.name), ...customTools.map((tool) => tool.name)],
      customTools: [...builtInTools, ...customTools],
      resourceLoader,
      sessionManager,
      settingsManager,
    })
    this.#session = session
    this.#subscribeAgentMessages(session)
    this.#unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        if (event.assistantMessageEvent.type === "text_delta")
          this.#emit({ type: "text_delta", delta: event.assistantMessageEvent.delta })
        if (event.assistantMessageEvent.type === "thinking_delta")
          this.#emit({ type: "thinking_delta", delta: event.assistantMessageEvent.delta })
        const message =
          "partial" in event.assistantMessageEvent
            ? event.assistantMessageEvent.partial
            : "message" in event.assistantMessageEvent
              ? event.assistantMessageEvent.message
              : event.assistantMessageEvent.error
        this.#emit({
          type: "usage_updated",
          outputTokens: message.usage.output,
        })
      } else if (event.type === "tool_execution_start") {
        this.#toolStarts.set(event.toolCallId, Date.now())
        this.#emit({ type: "tool_started", callId: event.toolCallId, name: event.toolName, arguments: event.args })
      } else if (event.type === "tool_execution_update") {
        this.#emit({
          type: "tool_updated",
          callId: event.toolCallId,
          name: event.toolName,
          output: toolResultText(event.partialResult),
        })
      } else if (event.type === "tool_execution_end") {
        const finishedAt = Date.now()
        this.#toolTimings.set(event.toolCallId, {
          startedAt: this.#toolStarts.get(event.toolCallId) ?? finishedAt,
          finishedAt,
        })
        this.#emit({ type: "tool_finished", callId: event.toolCallId, name: event.toolName, isError: event.isError })
      } else if (event.type === "agent_settled") {
        this.#emit({ type: "settled" })
      } else if (event.type === "compaction_end" && event.result) {
        const firstKeptRecordId = this.#resolveBoundaryRecordId(session.sessionManager, event.result.firstKeptEntryId)
        this.#emit({
          type: "compaction",
          summary: event.result.summary,
          firstKeptRecordId,
          tokensBefore: event.result.tokensBefore,
        })
      }
    })
    return modelReference(model, session.thinkingLevel, thinkingConfig)
  }

  create(input: PiCreateInput): Promise<ModelRuntimeInfo> {
    return this.#start(input, [])
  }

  restore(input: PiRestoreInput): Promise<ModelRuntimeInfo> {
    return this.#start(input, input.records)
  }

  /** 视图会改变系统提示词和工具集合，只能在没有活动请求时原子替换。 */
  async refreshView(view: ResolvedViewResources): Promise<void> {
    const session = this.#requireSession()
    if (this.#activePrompt || !session.isIdle) throw new Error("生成或执行工具期间不能刷新视图")
    if (!this.#settingsManager || !this.#viewLoader || !this.#cwd) throw new Error("视图加载器尚未初始化")
    const loader = createViewLoader(this.#cwd, view, this.#settingsManager)
    await loader.reload()
    this.#validateViewLoader(loader, view.viewId)
    this.#viewLoader.replace(loader)
    session.setActiveToolsByName(session.getActiveToolNames())
  }

  async switchView(view: ResolvedViewResources, _records: SessionRecord[]): Promise<ModelRuntimeInfo> {
    await this.refreshView(view)
    const session = this.#requireSession()
    const model = session.model
    if (!model) throw new Error("当前会话没有模型")
    return modelReference(model, session.thinkingLevel, this.#thinkingConfigs.get(`${model.provider}\0${model.id}`))
  }

  /**
   * 将当轮输入临时合并到 pi 上下文，并用活动请求信息覆盖完整工具循环。
   * useLater=false 的临时输入在请求结束后移除，不得累积到下一轮。
   * 由于该链路直接驱动底层 Agent，压缩阈值和溢出恢复也必须在此显式执行。
   */
  async prompt(input: PiPromptInput): Promise<void> {
    const session = this.#requireSession()
    if (this.#activePrompt || !session.isIdle) throw new Error("当前会话仍在运行")
    // AgentSession.isIdle 不覆盖 adapter 直接调用 agent.continue() 的生命周期，必须由 adapter 自己持有请求锁。
    const running = (async () => {
      this.#contentStarts.clear()
      this.#contentTimings.clear()
      this.#toolStarts.clear()
      this.#toolTimings.clear()
      await this.#compactBeforePrompt(session)
      const mapped = turnInputToPi(input.items, Date.now())
      const allMessages = mapped.map((item) => item.message)
      const persistentMessages = mapped.filter((item) => item.persistent).map((item) => item.message)
      const temporaryMessages = new Set(mapped.filter((item) => !item.persistent).map((item) => item.message))
      const before = session.agent.state.messages
      for (const message of persistentMessages) {
        const entryId = session.sessionManager.appendMessage(message)
        this.#registerEntry(input.recordId, entryId)
      }
      session.agent.state.messages = [...before, ...allMessages]
      this.#activePromptInput = input
      try {
        await session.agent.continue()
        await this.#compactAfterPrompt(session, allMessages, persistentMessages)
      } finally {
        this.#activePromptInput = undefined
        session.agent.state.messages = session.agent.state.messages.filter(
          (message) => message.role !== "user" || !temporaryMessages.has(message),
        )
      }
    })()
    this.#activePrompt = running
    try {
      await running
    } finally {
      if (this.#activePrompt === running) this.#activePrompt = undefined
    }
  }

  /** 手动压缩当前内存会话，结果通过既有 compaction 事件交给核心落盘。 */
  async compact(customInstructions?: string): Promise<void> {
    const session = this.#requireSession()
    if (this.#activePrompt || this.#activeCompaction || !session.isIdle)
      throw new Error("生成或执行工具期间不能压缩会话")
    const running = session.compact(customInstructions).then(() => {})
    this.#activeCompaction = running
    try {
      await running
      this.#subscribeAgentMessages(session)
    } finally {
      if (this.#activeCompaction === running) this.#activeCompaction = undefined
    }
  }

  async #compactBeforePrompt(session: AgentSession): Promise<void> {
    const assistant = this.#lastAssistant(session)
    if (!assistant || assistant.stopReason === "aborted") return
    if (isContextOverflow(assistant, session.model?.contextWindow ?? 0) || this.#overCompactionThreshold(session)) {
      await session.compact()
      this.#subscribeAgentMessages(session)
    }
  }

  async #compactAfterPrompt(
    session: AgentSession,
    currentMessages: PiUserMessage[],
    persistentMessages: PiUserMessage[],
  ): Promise<void> {
    const assistant = this.#lastAssistant(session)
    if (!assistant) return
    if (isContextOverflow(assistant, session.model?.contextWindow ?? 0)) {
      if (assistant.stopReason === "stop") {
        await session.compact()
        this.#subscribeAgentMessages(session)
        return
      }
      await session.compact()
      this.#subscribeAgentMessages(session)
      const messages = session.agent.state.messages
      if (messages.at(-1) === assistant) session.agent.state.messages = messages.slice(0, -1)
      this.#restoreCurrentTurnMessages(session, currentMessages, persistentMessages)
      await session.agent.continue()
      return
    }
    if (this.#overCompactionThreshold(session)) {
      await session.compact()
      this.#subscribeAgentMessages(session)
    }
  }

  #restoreCurrentTurnMessages(
    session: AgentSession,
    currentMessages: PiUserMessage[],
    persistentMessages: PiUserMessage[],
  ): void {
    const persistent = new Set(persistentMessages)
    const firstIndex = session.agent.state.messages.findIndex((message) => persistent.has(message as PiUserMessage))
    if (firstIndex < 0) throw new Error("压缩后无法恢复当前轮输入")
    session.agent.state.messages = [
      ...session.agent.state.messages.slice(0, firstIndex),
      ...currentMessages,
      ...session.agent.state.messages.slice(firstIndex).filter((message) => !persistent.has(message as PiUserMessage)),
    ]
  }

  #overCompactionThreshold(session: AgentSession): boolean {
    const usage = session.getContextUsage()
    if (usage?.tokens === null || usage === undefined) return false
    return shouldCompact(usage.tokens, usage.contextWindow, DEFAULT_COMPACTION_SETTINGS)
  }

  #lastAssistant(session: AgentSession): PiAssistantMessage | undefined {
    return [...session.agent.state.messages]
      .reverse()
      .find((message): message is PiAssistantMessage => message.role === "assistant")
  }

  setToolRegistrations(registrations: AizenToolRegistration[]): void {
    if (this.#session) throw new Error("会话运行时创建后不能替换工具注册")
    this.#toolRegistrations = [...registrations]
  }

  setPermissionBatchHandler(handler: PiPermissionBatchHandler | undefined): void {
    this.#permissionBatchHandler = handler
  }

  setPermissionHandler(handler: PiPermissionHandler | undefined): void {
    this.#permissionHandler = handler
  }

  #requireAllowed(authorization: ToolAuthorization): Extract<ToolAuthorization, { type: "allow" }> {
    if (authorization.type === "allow") return authorization
    if (authorization.type === "aborted") throw new Error(permissionFailureMessage(authorization))
    // 编辑预览失败不是权限拒绝，而是无法生成可靠 diff，用 Operation failed 呈现。
    const previewError =
      authorization.assessment?.details &&
      typeof authorization.assessment.details === "object" &&
      !Array.isArray(authorization.assessment.details) &&
      typeof authorization.assessment.details.previewError === "string"
        ? authorization.assessment.details.previewError
        : undefined
    if (authorization.source === "validator" && previewError !== undefined)
      throw new Error(`Operation failed: ${authorization.reason}`)
    const message = permissionFailureMessage(authorization)
    throw new Error(
      message.startsWith("Operation denied:")
        ? message
        : `Operation denied: ${authorization.source} rejected the tool call. Reason: ${message}`,
    )
  }

  #registerPermissionCall(
    cwd: string,
    call: { callId: string; name: string; arguments: JsonValue; declaredIntent: string; signal?: AbortSignal },
  ): void {
    const prompt = this.#activePromptInput
    let batch = this.#permissionBatch
    if (!prompt?.sessionId) return
    if (!batch) {
      this.#toolBatchSequence += 1
      batch = {
        batchId: `${prompt.turnId}:${this.#toolBatchSequence}`,
        requests: new Map(),
        pending: new Map(),
        ...(call.signal ? { signal: call.signal } : {}),
        dispatchQueued: false,
      }
      this.#permissionBatch = batch
    }
    batch.requests.set(call.callId, {
      sessionId: prompt.sessionId,
      turnId: prompt.turnId,
      toolCallId: call.callId,
      toolName: call.name,
      arguments: call.arguments,
      declaredIntent: call.declaredIntent,
      cwd,
      ...(prompt.permissionPreset ? { permissionPreset: prompt.permissionPreset } : {}),
      ...(prompt.permissionReviewMode ? { permissionReviewMode: prompt.permissionReviewMode } : {}),
      ...(call.name === "bash" ? { environment: { shell: this.#shellKind() } } : {}),
    })
    if (batch.dispatchQueued) return
    batch.dispatchQueued = true
    queueMicrotask(() => void this.#dispatchPermissionBatch(batch))
  }

  async #dispatchPermissionBatch(batch: PermissionBatchState): Promise<void> {
    if (this.#permissionBatch !== batch || !this.#permissionBatchHandler || batch.requests.size === 0) return
    try {
      const result = await this.#permissionBatchHandler(
        { batchId: batch.batchId, calls: [...batch.requests.values()] },
        batch.signal,
      )
      const byCall = new Map(result.authorizations.map((item) => [item.toolCallId, item.authorization]))
      for (const [callId, pending] of batch.pending) {
        const authorization = byCall.get(callId)
        if (authorization) pending.resolve(authorization)
        else pending.reject(new Error(`权限批次缺少工具结果：${callId}`))
      }
    } catch (error) {
      const actual = error instanceof Error ? error : new Error(String(error))
      for (const pending of batch.pending.values()) pending.reject(actual)
    } finally {
      if (this.#permissionBatch === batch) this.#permissionBatch = undefined
    }
  }

  setPermissionExecutionHandler(handler: PiPermissionExecutionHandler | undefined): void {
    this.#permissionExecutionHandler = handler
  }

  permissionReviewer(reference: Pick<ModelReference, "providerId" | "modelId">): PiPermissionReviewer {
    const sourceModel = this.#modelRuntime.getModel(reference.providerId, reference.modelId)
    if (!sourceModel) throw new Error(`找不到工具审核模型：${reference.providerId}/${reference.modelId}`)
    const modelKey = `${sourceModel.provider}\0${sourceModel.id}`
    return new PiPermissionReviewer(
      this.#modelRuntime,
      runtimeModel(sourceModel, this.#thinkingConfigs.get(modelKey), this.#modelBaseUrls.get(modelKey)),
    )
  }

  async generateSessionTitle(input: PiSessionTitleInput): Promise<string> {
    const sourceModel = this.#modelRuntime.getModel(input.model.providerId, input.model.modelId)
    if (!sourceModel) throw new Error(`找不到命名模型：${input.model.providerId}/${input.model.modelId}`)
    const modelKey = `${sourceModel.provider}\0${sourceModel.id}`
    const model = runtimeModel(sourceModel, this.#thinkingConfigs.get(modelKey), this.#modelBaseUrls.get(modelKey))
    return generateSessionTitle(this.#modelRuntime, model, input.firstUserMessage, input.signal)
  }

  /** 中止 pi Agent 的真实活动请求，并等待 adapter 的清理 finally 完成后再返回。 */
  async abort(): Promise<void> {
    const session = this.#requireSession()
    session.agent.abort()
    session.abortCompaction()
    await Promise.all([this.#activePrompt, this.#activeCompaction])
  }

  /** 模型配置只允许在 session 空闲时重载，保证一个完整工具循环使用同一份运行参数。 */
  async reloadModelConfig(): Promise<void> {
    if (this.#activePrompt || (this.#session && !this.#session.isIdle))
      throw new Error("生成或执行工具期间不能重新加载模型配置")
    await this.#modelRuntime.reloadConfig()
    const configError = this.#modelRuntime.getError()
    if (configError) throw new Error(`custom-providers.json 配置错误：${configError}`)
    await this.#reloadModelConfigs()
    if (this.#modelConfigError) throw this.#modelConfigError
  }

  async listModels(): Promise<ModelOption[]> {
    await this.reloadModelConfig()
    const available = new Set(
      (await this.#modelRuntime.getAvailable()).map((model) => `${model.provider}\0${model.id}`),
    )
    const enabledPiProviders = this.#piProviderRuntime ? await this.#piProviderRuntime.enabledProviderIds() : undefined
    return this.#modelRuntime.getModels().map((model) => {
      const configured = this.#thinkingConfigs.get(`${model.provider}\0${model.id}`)
      const builtin = configured === undefined
      const supported = builtin ? getSupportedThinkingLevels(model) : []
      const preferred = builtin && model.reasoning ? clampThinkingLevel(model, "medium") : undefined
      return {
        providerId: model.provider,
        modelId: model.id,
        ...(configured
          ? { thinkingLevel: configured.defaultThinkingLevel }
          : preferred
            ? { thinkingLevel: preferred }
            : {}),
        name: model.name,
        contextWindow: model.contextWindow,
        available:
          available.has(`${model.provider}\0${model.id}`) &&
          (enabledPiProviders === undefined ||
            !this.#piProviderRuntime?.isBuiltin(model.provider) ||
            enabledPiProviders.has(model.provider)),
        ...(configured
          ? {
              thinkingLevels: [...configured.thinkingLevels],
              ...(configured.disableThinkingLevel === undefined
                ? {}
                : { offThinkingLevel: configured.disableThinkingLevel }),
            }
          : builtin && model.reasoning
            ? {
                thinkingLevels: supported.filter((level) => level !== "off"),
                ...(supported.includes("off") ? { offThinkingLevel: "off" } : {}),
              }
            : {}),
      }
    })
  }

  /** 在写入 pi session 前完成模型和思考档位校验，失败时保留原模型。 */
  async setModel(reference: ModelReference): Promise<ModelRuntimeInfo> {
    const session = this.#requireSession()
    if (this.#activePrompt || !session.isIdle) throw new Error("生成或执行工具期间不能切换模型")
    const sourceModel = this.#modelRuntime.getModel(reference.providerId, reference.modelId)
    if (!sourceModel) throw new PiModelRuntimeError(`找不到模型：${reference.providerId}/${reference.modelId}`)
    const modelKey = `${sourceModel.provider}\0${sourceModel.id}`
    const thinkingConfig = this.#thinkingConfigs.get(modelKey)
    const model = runtimeModel(sourceModel, thinkingConfig, this.#modelBaseUrls.get(modelKey))
    let thinkingLevel: ThinkingLevel
    try {
      thinkingLevel = internalThinkingLevel(model, reference.thinkingLevel, thinkingConfig)
    } catch (error) {
      throw new PiModelRuntimeError(error instanceof Error ? error.message : String(error))
    }
    await session.setModel(model)
    session.setThinkingLevel(thinkingLevel)
    return modelReference(model, session.thinkingLevel, thinkingConfig)
  }

  async listAuthProviders(): Promise<AuthProviderOption[]> {
    return this.#modelRuntime.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      configured: this.#modelRuntime.hasConfiguredAuth(provider.id),
      supportsApiKey: provider.auth.apiKey?.login !== undefined,
    }))
  }

  async listProviders(): Promise<PiProviderOption[]> {
    if (!this.#piProviderRuntime) return []
    return this.#piProviderRuntime.list()
  }

  async setProviderEnabled(providerId: string, enabled: boolean): Promise<void> {
    if (!this.#piProviderRuntime || !this.#piProviderStore) throw new Error("当前运行模式不支持 pi 供应商管理")
    if (!enabled && this.#session?.model?.provider === providerId)
      throw new Error("不能停用当前会话正在使用的 pi 供应商")
    await this.#piProviderRuntime.setEnabled(providerId, enabled)
  }

  async refreshProvider(providerId: string, signal?: AbortSignal): Promise<void> {
    if (!this.#piProviderRuntime) throw new Error("当前运行模式不支持 pi 供应商管理")
    await this.#piProviderRuntime.refresh(providerId, signal)
  }

  async loginProvider(providerId: string, authType: ProviderAuthType): Promise<void> {
    if (!this.#piProviderRuntime) throw new Error("当前运行模式不支持 pi 供应商管理")
    await this.#piProviderRuntime.login(providerId, authType)
  }

  async loginApiKey(providerId: string): Promise<void> {
    if (this.#authAbortController) throw new Error("已有认证流程正在运行")
    const controller = new AbortController()
    this.#authAbortController = controller
    try {
      await this.#modelRuntime.login(providerId, "api_key", {
        signal: controller.signal,
        prompt: (prompt) => this.#requestAuthAnswer(prompt, controller.signal),
        notify: (event) => {
          if (event.type === "info" || event.type === "progress")
            this.#emit({ type: "auth_notice", message: event.message })
        },
      })
    } catch (error) {
      if (controller.signal.aborted) throw new Error("认证已取消")
      throw error
    } finally {
      this.#authAbortController = undefined
      for (const pending of this.#authAnswers.values()) pending.reject(new Error("认证已结束"))
      this.#authAnswers.clear()
    }
  }

  answerAuthPrompt(promptId: string, value: string): void {
    if (this.#piProviderRuntime?.answer(promptId, value)) return
    const pending = this.#authAnswers.get(promptId)
    if (!pending) throw new Error("当前没有等待回答的认证提示")
    this.#authAnswers.delete(promptId)
    pending.resolve(value)
  }

  cancelAuth(): void {
    this.#piProviderRuntime?.cancel()
    this.#authAbortController?.abort()
    for (const pending of this.#authAnswers.values()) pending.reject(new Error("认证已取消"))
    this.#authAnswers.clear()
  }

  subscribe(listener: (event: PiPortEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** 释放前等待活动请求完成清理，避免事件订阅和临时上下文被半途拆除。 */
  async dispose(): Promise<void> {
    await this.#disposeSession()
  }

  #handleAgentMessageEvent(session: AgentSession, event: AgentEvent): void {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent
      if (update.type === "text_start" || update.type === "thinking_start") {
        this.#contentStarts.set(update.contentIndex, Date.now())
      } else if (update.type === "text_end" || update.type === "thinking_end") {
        const finishedAt = Date.now()
        this.#contentTimings.set(update.contentIndex, {
          startedAt: this.#contentStarts.get(update.contentIndex) ?? finishedAt,
          finishedAt,
        })
      }
    }
    if (event.type !== "message_end" || (event.message.role !== "assistant" && event.message.role !== "toolResult"))
      return
    const entries = session.sessionManager.getEntries()
    const entry = entries.at(-1)
    if (entry?.type !== "message" || entry.message !== event.message) throw new Error("pi 没有保存已完成消息")
    const recordId = this.#entryRecordIds.get(entry.id) ?? crypto.randomUUID()
    this.#registerEntry(recordId, entry.id)
    this.#emit({
      type: "message",
      recordId,
      record: piMessageToCore(event.message, { content: this.#contentTimings, tools: this.#toolTimings }),
    })
  }

  /**
   * pi 压缩会重新连接自身 Agent 监听器并把它排到外部监听器之后；
   * 每次压缩后重订阅，保证 pi 先写入内存会话，再向核心发布完成消息。
   */
  #subscribeAgentMessages(session: AgentSession): void {
    this.#unsubscribeAgent?.()
    this.#unsubscribeAgent = session.agent.subscribe((event) => this.#handleAgentMessageEvent(session, event))
  }

  #emit(event: PiPortEvent): void {
    for (const listener of this.#listeners) listener(event)
  }

  #requireSession(): AgentSession {
    if (!this.#session) throw new Error("尚未创建会话")
    return this.#session
  }

  /** 内部 session 替换也遵守活动请求生命周期；正常入口会在调用前拒绝运行中替换。 */
  async #disposeSession(): Promise<void> {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    this.#unsubscribeAgent?.()
    this.#unsubscribeAgent = undefined
    if (this.#session) {
      if (this.#activePrompt || this.#activeCompaction) {
        this.#session.agent.abort()
        this.#session.abortCompaction()
        await Promise.all([this.#activePrompt, this.#activeCompaction])
      } else if (!this.#session.isIdle) await this.#session.abort()
      this.#session.dispose()
    }
    this.#session = undefined
    this.#entryRecordIds.clear()
    this.#recordEntries.clear()
    this.#viewLoader = undefined
    this.#settingsManager = undefined
    this.#cwd = undefined
    this.#activePrompt = undefined
    this.#activeCompaction = undefined
    this.#contentStarts.clear()
    this.#contentTimings.clear()
    this.#toolStarts.clear()
    this.#toolTimings.clear()
  }

  #registerEntry(recordId: string, entryId: string): void {
    this.#entryRecordIds.set(entryId, recordId)
    if (!this.#recordEntries.has(recordId)) this.#recordEntries.set(recordId, entryId)
  }

  /**
   * 历史 model_changed 只保留“这里曾切换模型”的记录，不按当前 custom-providers.json
   * 校验其中的旧思考档位。只有下一次实际发送所用的模型和档位由 #start 严格校验。
   */
  #restoreEntries(sessionManager: SessionManager, records: SessionRecord[]): void {
    for (const record of projectVisibleSessionRecords(records)) {
      if (record.kind === "model_changed") {
        this.#registerEntry(
          record.recordId,
          sessionManager.appendModelChange(record.model.providerId, record.model.modelId),
        )
      } else if (record.kind === "working_directory_changed") {
        this.#registerEntry(
          record.recordId,
          sessionManager.appendCustomMessageEntry(
            "working-directory-change",
            workingDirectoryChangeText(record.previousCwd, record.currentCwd),
            true,
            { previousCwd: record.previousCwd, currentCwd: record.currentCwd },
          ),
        )
      } else if (record.kind === "turn_started") {
        for (const mapped of turnInputToPi(
          record.items.filter((item) => item.useLater),
          Date.parse(record.at),
        )) {
          this.#registerEntry(record.recordId, sessionManager.appendMessage(mapped.message))
        }
      } else if (record.kind === "message") {
        this.#registerEntry(
          record.recordId,
          sessionManager.appendMessage(coreMessageToPi(record.message, Date.parse(record.at))),
        )
      } else if (record.kind === "compaction") {
        const firstKeptEntryId = this.#recordEntries.get(record.firstKeptRecordId)
        if (!firstKeptEntryId) throw new Error(`上下文压缩引用了不存在的记录：${record.firstKeptRecordId}`)
        this.#registerEntry(
          record.recordId,
          sessionManager.appendCompaction(record.summary, firstKeptEntryId, record.tokensBefore),
        )
      }
    }
  }

  #resolveBoundaryRecordId(sessionManager: SessionManager, firstKeptEntryId: string): string {
    const entries = sessionManager.getEntries()
    const boundaryIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId)
    if (boundaryIndex < 0) throw new Error("pi 返回了不存在的上下文压缩位置")
    for (let index = boundaryIndex; index < entries.length; index++) {
      const recordId = this.#entryRecordIds.get(entries[index]?.id ?? "")
      if (recordId) return recordId
    }
    for (let index = boundaryIndex - 1; index >= 0; index--) {
      const recordId = this.#entryRecordIds.get(entries[index]?.id ?? "")
      if (recordId) return recordId
    }
    throw new Error("上下文压缩位置无法对应到会话记录")
  }

  async #reloadModelConfigs(): Promise<void> {
    this.#thinkingConfigs.clear()
    this.#modelBaseUrls.clear()
    this.#modelConfigError = undefined
    if (!this.#customProvidersPath) return
    try {
      const snapshot = await new ModelConfigStore(this.#customProvidersPath).read()
      for (const provider of snapshot.providers) {
        for (const model of provider.models) {
          const modelKey = `${provider.id}\0${model.id}`
          this.#thinkingConfigs.set(modelKey, model.thinking ?? null)
          if (model.baseUrl !== undefined) this.#modelBaseUrls.set(modelKey, model.baseUrl)
        }
      }
    } catch (error) {
      this.#modelConfigError = error instanceof Error ? error : new Error(String(error))
    }
  }

  #shellKind(): string {
    try {
      const shell = getShellConfig().shell.replace(/\\/g, "/").toLowerCase()
      return shell.includes("/git/") && shell.endsWith("/bash.exe") ? "git-bash" : "other"
    } catch {
      return "other"
    }
  }

  #validateViewLoader(loader: ResourceLoader, viewId: ResolvedViewResources["viewId"]): void {
    // 同名碰撞是三层技能（视图 > 用户 > 项目）的既定优先级，先到先得，不视为错误。
    const diagnostics = loader.getSkills().diagnostics.filter((item) => item.type !== "collision")
    if (viewId === null || diagnostics.length === 0) return
    const details = diagnostics.map((item) => `${item.path ?? "Skill"}: ${item.message}`).join("；")
    throw new Error(`视图 ${viewId} 的 Skill 无效：${details}`)
  }

  #requestAuthAnswer(prompt: AuthPrompt, signal: AbortSignal): Promise<string> {
    const promptId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#authAnswers.delete(promptId)
        reject(new Error("认证已取消"))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      this.#authAnswers.set(promptId, {
        resolve: (value) => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort)
          reject(error)
        },
      })
      const promptType = prompt.type === "secret" ? "secret" : prompt.type === "select" ? "select" : "text"
      this.#emit({
        type: "auth_prompt",
        promptId,
        promptType,
        message: prompt.message,
        ...("placeholder" in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
        ...(prompt.type === "select" ? { options: prompt.options.map((option) => ({ ...option })) } : {}),
      })
    })
  }
}
