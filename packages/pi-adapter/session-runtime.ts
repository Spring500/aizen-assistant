import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core"
import {
  type Api,
  type AuthPrompt,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai"
import {
  type AgentSession,
  createAgentSession,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { ModelConfigStore, type ModelThinkingConfig } from "../core/model-config-store.ts"
import type {
  AuthProviderOption,
  ModelOption,
  ModelRuntimeInfo,
  PiCreateInput,
  PiPort,
  PiPortEvent,
  PiPromptInput,
  PiRestoreInput,
  ViewRuntimeInput,
} from "../core/pi-port.ts"
import type { ModelReference, SessionRecord } from "../core/session-format.ts"
import { coreMessageToPi, piMessageToCore, turnInputToPi } from "./message-mapper.ts"

export type PiSessionRuntimeOptions = {
  authPath: string
  modelsPath: string | null
}

function externalThinkingLevel(model: Model<Api>, level: ModelThinkingLevel): string {
  return model.thinkingLevelMap?.[level] ?? level
}

function internalThinkingLevel(model: Model<Api>, level: string): ThinkingLevel {
  const supported = getSupportedThinkingLevels(model)
  const matched = supported.find((candidate) => externalThinkingLevel(model, candidate) === level)
  if (matched) return matched
  if (supported.includes(level as ModelThinkingLevel)) return level as ThinkingLevel
  throw new Error(`模型 ${model.provider}/${model.id} 不支持思考档位：${level}`)
}

function modelReference(model: Model<Api>, thinkingLevel: ThinkingLevel) {
  return {
    providerId: model.provider,
    modelId: model.id,
    api: model.api,
    thinkingLevel: externalThinkingLevel(model, thinkingLevel),
    contextWindow: model.contextWindow,
  }
}

function createViewLoader(
  cwd: string,
  view: ViewRuntimeInput,
  settingsManager: SettingsManager,
): DefaultResourceLoader {
  const emptyView = view.viewId === null
  const directory = emptyView ? cwd : view.directory
  const systemPath = join(directory, "SYSTEM.md")
  const agentsPath = join(directory, "AGENTS.md")
  return new DefaultResourceLoader({
    cwd,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalSkillPaths: !emptyView && existsSync(join(directory, "skills")) ? [join(directory, "skills")] : [],
    systemPromptOverride: () => (!emptyView && existsSync(systemPath) ? readFileSync(systemPath, "utf8") : undefined),
    agentsFilesOverride: () => ({
      agentsFiles:
        !emptyView && existsSync(agentsPath) ? [{ path: agentsPath, content: readFileSync(agentsPath, "utf8") }] : [],
    }),
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

function auditedTools(cwd: string): ToolDefinition[] {
  const intent = Type.Object({
    declaredIntent: Type.String({
      minLength: 1,
      maxLength: 50,
      description: "用不超过 50 个字符的一句话说明本次工具调用的目的，供用户阅读和审计",
    }),
  })
  return [createReadTool(cwd), createBashTool(cwd), createEditTool(cwd), createWriteTool(cwd)].map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: Type.Intersect([tool.parameters, intent]),
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    async execute(callId, params, signal, onUpdate) {
      const { declaredIntent: _declaredIntent, ...actualParams } = params as Record<string, unknown>
      return tool.execute(callId, actualParams as never, signal, onUpdate)
    },
  }))
}

export class PiSessionRuntime implements PiPort {
  readonly #modelRuntime: ModelRuntime
  readonly #modelsPath: string | null
  readonly #listeners = new Set<(event: PiPortEvent) => void>()
  #thinkingConfigs = new Map<string, ModelThinkingConfig>()
  #session: AgentSession | undefined
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

  private constructor(modelRuntime: ModelRuntime, modelsPath: string | null) {
    this.#modelRuntime = modelRuntime
    this.#modelsPath = modelsPath
  }

  static async create(options: PiSessionRuntimeOptions): Promise<PiSessionRuntime> {
    const runtime = new PiSessionRuntime(
      await ModelRuntime.create({ ...options, allowModelNetwork: false }),
      options.modelsPath,
    )
    await runtime.#reloadThinkingConfigs().catch(() => {})
    return runtime
  }

  async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.#modelRuntime.setRuntimeApiKey(providerId, apiKey)
  }

  setModelBaseUrl(providerId: string, modelId: string, baseUrl: string): void {
    const model = this.#modelRuntime.getModel(providerId, modelId)
    if (!model) throw new Error(`找不到模型：${providerId}/${modelId}`)
    model.baseUrl = baseUrl
  }

  async #start(input: PiCreateInput, records: SessionRecord[]): Promise<ModelRuntimeInfo> {
    await this.#disposeSession()
    const model = this.#modelRuntime.getModel(input.model.providerId, input.model.modelId)
    if (!model) throw new Error(`找不到模型：${input.model.providerId}/${input.model.modelId}`)
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } })
    const initialLoader = createViewLoader(input.cwd, input.view, settingsManager)
    await initialLoader.reload()
    this.#validateViewLoader(initialLoader, input.view.viewId)
    const resourceLoader = new MutableViewLoader(initialLoader)
    this.#viewLoader = resourceLoader
    this.#settingsManager = settingsManager
    this.#cwd = input.cwd
    const sessionManager = SessionManager.inMemory(input.cwd)
    this.#restoreEntries(sessionManager, records)
    const { session } = await createAgentSession({
      cwd: input.cwd,
      modelRuntime: this.#modelRuntime,
      model,
      thinkingLevel: internalThinkingLevel(model, input.model.thinkingLevel),
      tools: ["read", "bash", "edit", "write"],
      customTools: auditedTools(input.cwd),
      resourceLoader,
      sessionManager,
      settingsManager,
    })
    this.#session = session
    this.#unsubscribeAgent = session.agent.subscribe((event) => {
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
      const entry = entries[entries.length - 1]
      if (entry?.type !== "message" || entry.message !== event.message) throw new Error("pi 没有保存已完成消息")
      const recordId = this.#entryRecordIds.get(entry.id) ?? crypto.randomUUID()
      this.#registerEntry(recordId, entry.id)
      this.#emit({
        type: "message",
        recordId,
        record: piMessageToCore(event.message, { content: this.#contentTimings, tools: this.#toolTimings }),
      })
    })
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
        const usage = message.usage
        this.#emit({
          type: "usage_updated",
          outputTokens: usage.output,
          contextTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
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
    return modelReference(model, session.thinkingLevel)
  }

  create(input: PiCreateInput): Promise<ModelRuntimeInfo> {
    return this.#start(input, [])
  }

  restore(input: PiRestoreInput): Promise<ModelRuntimeInfo> {
    return this.#start(input, input.records)
  }

  async refreshView(view: ViewRuntimeInput): Promise<void> {
    const session = this.#requireSession()
    if (!session.isIdle) throw new Error("生成或执行工具期间不能刷新视图")
    if (!this.#settingsManager || !this.#viewLoader || !this.#cwd) throw new Error("视图加载器尚未初始化")
    const loader = createViewLoader(this.#cwd, view, this.#settingsManager)
    await loader.reload()
    this.#validateViewLoader(loader, view.viewId)
    this.#viewLoader.replace(loader)
    session.setActiveToolsByName(session.getActiveToolNames())
  }

  async switchView(view: ViewRuntimeInput, _records: SessionRecord[]): Promise<ModelRuntimeInfo> {
    await this.refreshView(view)
    const session = this.#requireSession()
    const model = session.model
    if (!model) throw new Error("当前会话没有模型")
    return modelReference(model, session.thinkingLevel)
  }

  async prompt(input: PiPromptInput): Promise<void> {
    const session = this.#requireSession()
    if (!session.isIdle) throw new Error("当前会话仍在运行")
    this.#contentStarts.clear()
    this.#contentTimings.clear()
    this.#toolStarts.clear()
    this.#toolTimings.clear()
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
    try {
      await session.agent.continue()
    } finally {
      session.agent.state.messages = session.agent.state.messages.filter(
        (message) => message.role !== "user" || !temporaryMessages.has(message),
      )
    }
  }

  abort(): Promise<void> {
    return this.#requireSession().abort()
  }

  async reloadModelConfig(): Promise<void> {
    await this.#modelRuntime.reloadConfig()
    const configError = this.#modelRuntime.getError()
    if (configError) throw new Error(`models.json 配置错误：${configError}`)
    await this.#reloadThinkingConfigs().catch(() => {})
  }

  async listModels(): Promise<ModelOption[]> {
    await this.reloadModelConfig()
    const available = new Set(
      (await this.#modelRuntime.getAvailable()).map((model) => `${model.provider}\0${model.id}`),
    )
    return this.#modelRuntime.getModels().map((model) => {
      const supported = getSupportedThinkingLevels(model)
      const configured = this.#thinkingConfigs.get(`${model.provider}\0${model.id}`)
      const preferred = clampThinkingLevel(model, model.reasoning ? "medium" : "off")
      return {
        providerId: model.provider,
        modelId: model.id,
        api: model.api,
        thinkingLevel: configured?.defaultLevel ?? externalThinkingLevel(model, preferred),
        name: model.name,
        contextWindow: model.contextWindow,
        available: available.has(`${model.provider}\0${model.id}`),
        thinkingLevels:
          configured?.levels ??
          supported.filter((level) => level !== "off").map((level) => externalThinkingLevel(model, level)),
        ...(configured?.offLevel
          ? { offThinkingLevel: configured.offLevel }
          : configured
            ? {}
            : supported.includes("off")
              ? { offThinkingLevel: externalThinkingLevel(model, "off") }
              : {}),
      }
    })
  }

  async setModel(reference: ModelReference): Promise<ModelRuntimeInfo> {
    const session = this.#requireSession()
    if (!session.isIdle) throw new Error("生成或执行工具期间不能切换模型")
    const model = this.#modelRuntime.getModel(reference.providerId, reference.modelId)
    if (!model) throw new Error(`找不到模型：${reference.providerId}/${reference.modelId}`)
    await session.setModel(model)
    session.setThinkingLevel(internalThinkingLevel(model, reference.thinkingLevel))
    return modelReference(model, session.thinkingLevel)
  }

  async listAuthProviders(): Promise<AuthProviderOption[]> {
    return this.#modelRuntime.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      configured: this.#modelRuntime.hasConfiguredAuth(provider.id),
      supportsApiKey: provider.auth.apiKey?.login !== undefined,
    }))
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
    const pending = this.#authAnswers.get(promptId)
    if (!pending) throw new Error("当前没有等待回答的认证提示")
    this.#authAnswers.delete(promptId)
    pending.resolve(value)
  }

  cancelAuth(): void {
    this.#authAbortController?.abort()
    for (const pending of this.#authAnswers.values()) pending.reject(new Error("认证已取消"))
    this.#authAnswers.clear()
  }

  subscribe(listener: (event: PiPortEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  inspectMessages(): AgentMessage[] {
    return this.#requireSession().agent.state.messages
  }

  inspectSystemPrompt(): string {
    return this.#requireSession().systemPrompt
  }

  inspectSessionFile(): string | undefined {
    return this.#requireSession().sessionFile
  }

  async dispose(): Promise<void> {
    await this.#disposeSession()
  }

  #emit(event: PiPortEvent): void {
    for (const listener of this.#listeners) listener(event)
  }

  #requireSession(): AgentSession {
    if (!this.#session) throw new Error("尚未创建会话")
    return this.#session
  }

  async #disposeSession(): Promise<void> {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    this.#unsubscribeAgent?.()
    this.#unsubscribeAgent = undefined
    if (this.#session) {
      if (!this.#session.isIdle) await this.#session.abort()
      this.#session.dispose()
    }
    this.#session = undefined
    this.#entryRecordIds.clear()
    this.#recordEntries.clear()
    this.#viewLoader = undefined
    this.#settingsManager = undefined
    this.#cwd = undefined
    this.#contentStarts.clear()
    this.#contentTimings.clear()
    this.#toolStarts.clear()
    this.#toolTimings.clear()
  }

  #registerEntry(recordId: string, entryId: string): void {
    this.#entryRecordIds.set(entryId, recordId)
    if (!this.#recordEntries.has(recordId)) this.#recordEntries.set(recordId, entryId)
  }

  #restoreEntries(sessionManager: SessionManager, records: SessionRecord[]): void {
    const finishedTurns = new Set(
      records.filter((record) => record.kind === "turn_finished").map((record) => record.turnId),
    )
    for (const record of records) {
      if ((record.kind === "turn_started" || record.kind === "message") && !finishedTurns.has(record.turnId)) continue
      if (record.kind === "model_changed") {
        const model = this.#modelRuntime.getModel(record.model.providerId, record.model.modelId)
        if (!model) throw new Error(`找不到模型：${record.model.providerId}/${record.model.modelId}`)
        this.#registerEntry(
          record.recordId,
          sessionManager.appendModelChange(record.model.providerId, record.model.modelId),
        )
        this.#registerEntry(
          record.recordId,
          sessionManager.appendThinkingLevelChange(internalThinkingLevel(model, record.model.thinkingLevel)),
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

  async #reloadThinkingConfigs(): Promise<void> {
    this.#thinkingConfigs.clear()
    if (!this.#modelsPath) return
    const snapshot = await new ModelConfigStore(this.#modelsPath).read()
    for (const provider of snapshot.providers) {
      for (const model of provider.models) {
        if (model.thinking) this.#thinkingConfigs.set(`${provider.id}\0${model.id}`, model.thinking)
      }
    }
  }

  #validateViewLoader(loader: ResourceLoader, viewId: ViewRuntimeInput["viewId"]): void {
    const diagnostics = loader.getSkills().diagnostics
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
