import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core"
import type { Api, AuthPrompt, Model } from "@earendil-works/pi-ai"
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import type {
  AuthProviderOption,
  ModelOption,
  ModelRuntimeInfo,
  PiCreateInput,
  PiPort,
  PiPortEvent,
  PiPromptInput,
  PiRestoreInput,
} from "../core/pi-port.ts"
import type { ModelReference, SessionRecord } from "../core/session-format.ts"
import { coreMessageToPi, piMessageToCore, turnInputToPi } from "./message-mapper.ts"

export type PiSessionRuntimeOptions = {
  authPath: string
  modelsPath: string | null
}

function asThinkingLevel(level: string): ThinkingLevel {
  if (
    level === "off" ||
    level === "minimal" ||
    level === "low" ||
    level === "medium" ||
    level === "high" ||
    level === "xhigh" ||
    level === "max"
  )
    return level
  return "medium"
}

function modelReference(model: Model<Api>, thinkingLevel: ThinkingLevel) {
  return { providerId: model.provider, modelId: model.id, api: model.api, thinkingLevel, contextWindow: model.contextWindow }
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

export class PiSessionRuntime implements PiPort {
  readonly #modelRuntime: ModelRuntime
  readonly #listeners = new Set<(event: PiPortEvent) => void>()
  #session: AgentSession | undefined
  #unsubscribe: (() => void) | undefined
  #unsubscribeAgent: (() => void) | undefined
  #authAbortController: AbortController | undefined
  #authAnswers = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>()
  #entryRuntimeRefs = new Map<string, string>()
  #recordEntries = new Map<string, string>()

  private constructor(modelRuntime: ModelRuntime) {
    this.#modelRuntime = modelRuntime
  }

  static async create(options: PiSessionRuntimeOptions): Promise<PiSessionRuntime> {
    return new PiSessionRuntime(await ModelRuntime.create({ ...options, allowModelNetwork: false }))
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
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: input.cwd,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
    })
    await resourceLoader.reload()
    const sessionManager = SessionManager.inMemory(input.cwd)
    this.#restoreEntries(sessionManager, records)
    const { session } = await createAgentSession({
      cwd: input.cwd,
      modelRuntime: this.#modelRuntime,
      model,
      thinkingLevel: asThinkingLevel(input.model.thinkingLevel),
      tools: ["read", "bash", "edit", "write"],
      resourceLoader,
      sessionManager,
      settingsManager,
    })
    this.#session = session
    this.#unsubscribeAgent = session.agent.subscribe((event) => {
      if (event.type !== "message_end" || (event.message.role !== "assistant" && event.message.role !== "toolResult"))
        return
      const entries = session.sessionManager.getEntries()
      const entry = entries[entries.length - 1]
      if (entry?.type !== "message" || entry.message !== event.message) throw new Error("pi 没有保存已完成消息")
      const runtimeRef = this.#entryRuntimeRefs.get(entry.id) ?? entry.id
      this.#entryRuntimeRefs.set(entry.id, runtimeRef)
      this.#emit({ type: "message", runtimeRef, record: piMessageToCore(event.message) })
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
        this.#emit({ type: "tool_started", callId: event.toolCallId, name: event.toolName, arguments: event.args })
      } else if (event.type === "tool_execution_update") {
        this.#emit({
          type: "tool_updated",
          callId: event.toolCallId,
          name: event.toolName,
          output: toolResultText(event.partialResult),
        })
      } else if (event.type === "tool_execution_end") {
        this.#emit({ type: "tool_finished", callId: event.toolCallId, name: event.toolName, isError: event.isError })
      } else if (event.type === "agent_settled") {
        this.#emit({ type: "settled" })
      } else if (event.type === "compaction_end" && event.result) {
        const firstKeptRuntimeRef = this.#resolveBoundaryRuntimeRef(
          session.sessionManager,
          event.result.firstKeptEntryId,
        )
        this.#emit({
          type: "compaction",
          summary: event.result.summary,
          firstKeptRuntimeRef,
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

  async prompt(input: PiPromptInput): Promise<void> {
    const session = this.#requireSession()
    if (!session.isIdle) throw new Error("当前会话仍在运行")
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

  async listModels(): Promise<ModelOption[]> {
    await this.#modelRuntime.reloadConfig()
    const configError = this.#modelRuntime.getError()
    if (configError) throw new Error(`models.json 配置错误：${configError}`)
    const available = new Set(
      (await this.#modelRuntime.getAvailable()).map((model) => `${model.provider}\0${model.id}`),
    )
    return this.#modelRuntime.getModels().map((model) => ({
      providerId: model.provider,
      modelId: model.id,
      api: model.api,
      thinkingLevel: model.reasoning ? "medium" : "off",
      name: model.name,
      contextWindow: model.contextWindow,
      available: available.has(`${model.provider}\0${model.id}`),
    }))
  }

  async setModel(reference: ModelReference): Promise<ModelRuntimeInfo> {
    const session = this.#requireSession()
    if (!session.isIdle) throw new Error("生成或执行工具期间不能切换模型")
    const model = this.#modelRuntime.getModel(reference.providerId, reference.modelId)
    if (!model) throw new Error(`找不到模型：${reference.providerId}/${reference.modelId}`)
    await session.setModel(model)
    session.setThinkingLevel(asThinkingLevel(reference.thinkingLevel))
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

  inspectSessionFile(): string | undefined {
    return this.#requireSession().sessionFile
  }

  inspectEntryMappings(): Array<{ entryId: string; runtimeRef: string }> {
    return Array.from(this.#entryRuntimeRefs, ([entryId, runtimeRef]) => ({ entryId, runtimeRef }))
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
    this.#entryRuntimeRefs.clear()
    this.#recordEntries.clear()
  }

  #registerEntry(recordId: string, entryId: string): void {
    this.#entryRuntimeRefs.set(entryId, recordId)
    if (!this.#recordEntries.has(recordId)) this.#recordEntries.set(recordId, entryId)
  }

  #restoreEntries(sessionManager: SessionManager, records: SessionRecord[]): void {
    const finishedTurns = new Set(
      records.filter((record) => record.kind === "turn_finished").map((record) => record.turnId),
    )
    for (const record of records) {
      if ((record.kind === "turn_started" || record.kind === "message") && !finishedTurns.has(record.turnId)) continue
      if (record.kind === "model_changed") {
        this.#registerEntry(
          record.recordId,
          sessionManager.appendModelChange(record.model.providerId, record.model.modelId),
        )
        this.#registerEntry(record.recordId, sessionManager.appendThinkingLevelChange(record.model.thinkingLevel))
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

  #resolveBoundaryRuntimeRef(sessionManager: SessionManager, firstKeptEntryId: string): string {
    const entries = sessionManager.getEntries()
    const boundaryIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId)
    if (boundaryIndex < 0) throw new Error("pi 返回了不存在的上下文压缩位置")
    for (let index = boundaryIndex; index < entries.length; index++) {
      const runtimeRef = this.#entryRuntimeRefs.get(entries[index]?.id ?? "")
      if (runtimeRef) return runtimeRef
    }
    for (let index = boundaryIndex - 1; index >= 0; index--) {
      const runtimeRef = this.#entryRuntimeRefs.get(entries[index]?.id ?? "")
      if (runtimeRef) return runtimeRef
    }
    throw new Error("上下文压缩位置无法对应到会话记录")
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
