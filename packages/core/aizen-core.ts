import { join } from "node:path"
import type { PiPort, PiPortEvent } from "./pi-port.ts"
import type { ModelReference, SessionRecord, TurnFinishedRecord, TurnStartedRecord } from "./session-format.ts"
import type { SessionStore } from "./session-store.ts"
import {
  type CoreCommand,
  type CoreCommandResult,
  type CoreEvent,
  type CorePort,
  type CoreSnapshot,
  recordsToTranscript,
} from "./types.ts"
import { saveEmptyViewSnapshot } from "./view-snapshot.ts"

export type AizenCoreOptions = { cwd: string; store: SessionStore; pi: PiPort }

export class AizenCore implements CorePort {
  readonly #cwd: string
  readonly #store: SessionStore
  readonly #pi: PiPort
  readonly #listeners = new Set<(event: CoreEvent) => void>()
  readonly #unsubscribePi: () => void
  #snapshot: CoreSnapshot
  #records: SessionRecord[] = []
  #writeQueue = Promise.resolve()
  #currentTurnId: string | undefined
  #runtimeRecords = new Map<string, string>()
  #abortRequested = false
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
      authProviders: [],
      transcript: [],
      activeTools: [],
      streamingText: "",
      streamingThinking: "",
    }
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
    if (this.#disposed) return { ok: false, error: "核心已经关闭" }
    try {
      delete this.#snapshot.lastError
      if (
        command.type !== "abort" &&
        command.type !== "answer_auth_prompt" &&
        command.type !== "cancel_auth" &&
        this.#snapshot.status !== "idle"
      ) {
        throw new Error("当前操作尚未完成")
      }
      switch (command.type) {
        case "list_sessions":
          this.#snapshot.sessions = await this.#store.list()
          break
        case "list_models":
          this.#snapshot.models = await this.#pi.listModels()
          break
        case "list_auth_providers":
          this.#snapshot.authProviders = await this.#pi.listAuthProviders()
          break
        case "create_session":
          await this.#createSession(command.model)
          break
        case "open_session":
          await this.#openSession(command.sessionId)
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
      this.#snapshot.lastError = message
      if (this.#snapshot.status !== "running" && this.#snapshot.status !== "aborting") this.#snapshot.status = "idle"
      this.#notify()
      return { ok: false, error: message }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#snapshot.status === "running" || this.#snapshot.status === "aborting") await this.#pi.abort()
    await this.#writeQueue
    await this.#store.flush()
    this.#unsubscribePi()
    await this.#pi.dispose()
    this.#listeners.clear()
  }

  async #createSession(model: ModelReference): Promise<void> {
    const sessionId = crypto.randomUUID()
    const at = new Date().toISOString()
    await this.#store.create({ sessionId, cwd: this.#cwd, createdAt: at })
    const view = await saveEmptyViewSnapshot(join(this.#store.sessionDirectory(sessionId), "views"))
    const selectedView = { viewId: view.viewId, contentHash: view.contentHash }
    const actualModel = await this.#pi.create({ cwd: this.#cwd, model, view: selectedView })
    const records: SessionRecord[] = [
      { kind: "model_changed", recordId: crypto.randomUUID(), at, model: actualModel },
      { kind: "view_changed", recordId: crypto.randomUUID(), at, view: selectedView, reason: "selected" },
    ]
    for (const record of records) await this.#store.append(sessionId, record)
    this.#records = records
    this.#runtimeRecords.clear()
    this.#snapshot.currentSessionId = sessionId
    this.#snapshot.currentModel = actualModel
    this.#snapshot.currentView = selectedView
    this.#snapshot.transcript = []
    this.#snapshot.streamingText = ""
    this.#snapshot.streamingThinking = ""
    delete this.#snapshot.lastError
    this.#snapshot.sessions = await this.#store.list()
  }

  async #openSession(sessionId: string): Promise<void> {
    const loaded = await this.#store.read(sessionId)
    if (loaded.header.cwd !== this.#cwd) throw new Error("该会话不属于当前工作目录")
    const modelRecord = [...loaded.records].reverse().find((record) => record.kind === "model_changed")
    const viewRecord = [...loaded.records].reverse().find((record) => record.kind === "view_changed")
    if (modelRecord?.kind !== "model_changed") throw new Error("会话没有模型记录")
    if (viewRecord?.kind !== "view_changed") throw new Error("会话没有视图记录")
    const actualModel = await this.#pi.restore({
      cwd: this.#cwd,
      model: modelRecord.model,
      view: viewRecord.view,
      records: loaded.records,
    })
    this.#records = loaded.records
    this.#runtimeRecords = new Map(loaded.records.map((record) => [record.recordId, record.recordId]))
    this.#snapshot.currentSessionId = sessionId
    this.#snapshot.currentModel = actualModel
    this.#snapshot.currentView = viewRecord.view
    this.#snapshot.transcript = recordsToTranscript(loaded.records)
    this.#snapshot.streamingText = ""
    this.#snapshot.streamingThinking = ""
    if (loaded.warnings.length > 0) this.#snapshot.lastError = loaded.warnings.join("；")
    else delete this.#snapshot.lastError
  }

  async #sendPrompt(text: string): Promise<void> {
    const sessionId = this.#snapshot.currentSessionId
    const view = this.#snapshot.currentView
    if (!sessionId || !view) throw new Error("请先新建或恢复会话")
    if (!text.trim()) throw new Error("消息不能为空")
    const turnId = crypto.randomUUID()
    const started: TurnStartedRecord = {
      kind: "turn_started",
      recordId: crypto.randomUUID(),
      turnId,
      at: new Date().toISOString(),
      view,
      items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text }] }],
    }
    await this.#store.append(sessionId, started)
    this.#records.push(started)
    this.#runtimeRecords.set(started.recordId, started.recordId)
    this.#currentTurnId = turnId
    this.#snapshot.transcript.push({ type: "input", turnId, items: started.items })
    this.#snapshot.status = "running"
    this.#snapshot.streamingText = ""
    this.#snapshot.streamingThinking = ""
    this.#abortRequested = false
    this.#notify()
    let outcome: TurnFinishedRecord["outcome"] = "completed"
    let error: TurnFinishedRecord["error"]
    try {
      await this.#pi.prompt({ recordId: started.recordId, turnId, view, items: started.items })
      if (this.#abortRequested) outcome = "aborted"
    } catch (caught) {
      outcome = this.#abortRequested ? "aborted" : "failed"
      if (outcome === "failed")
        error = { code: "PI_REQUEST_FAILED", message: caught instanceof Error ? caught.message : String(caught) }
    }
    try {
      await this.#writeQueue
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
      await this.#store.append(sessionId, finished)
      this.#records.push(finished)
      this.#snapshot.transcript.push({ type: "turn_end", turnId, outcome })
      if (error) this.#snapshot.lastError = error.message
    } finally {
      this.#snapshot.status = "idle"
      this.#snapshot.activeTools = []
      this.#snapshot.streamingText = ""
      this.#snapshot.streamingThinking = ""
      this.#currentTurnId = undefined
      this.#notify()
    }
  }

  async #setModel(model: ModelReference): Promise<void> {
    const sessionId = this.#snapshot.currentSessionId
    if (!sessionId) throw new Error("请先新建或恢复会话")
    const actual = await this.#pi.setModel(model)
    const record: SessionRecord = {
      kind: "model_changed",
      recordId: crypto.randomUUID(),
      at: new Date().toISOString(),
      model: actual,
    }
    await this.#store.append(sessionId, record)
    this.#records.push(record)
    this.#snapshot.currentModel = actual
  }

  #handlePiEvent(event: PiPortEvent): void {
    if (event.type === "auth_prompt") {
      for (const listener of this.#listeners)
        listener({
          type: "auth_prompt",
          promptId: event.promptId,
          promptType: event.promptType,
          message: event.message,
        })
      return
    }
    if (event.type === "text_delta") this.#snapshot.streamingText += event.delta
    if (event.type === "thinking_delta") this.#snapshot.streamingThinking += event.delta
    if (event.type === "tool_started") this.#snapshot.activeTools.push({ callId: event.callId, name: event.name })
    if (event.type === "tool_finished") {
      const tool = this.#snapshot.activeTools.find((item) => item.callId === event.callId)
      if (tool) tool.isError = event.isError
    }
    if (event.type === "message" && this.#currentTurnId && this.#snapshot.currentSessionId) {
      const record: SessionRecord = {
        kind: "message",
        recordId: crypto.randomUUID(),
        turnId: this.#currentTurnId,
        at: new Date().toISOString(),
        message: event.record,
      }
      this.#runtimeRecords.set(event.runtimeRef, record.recordId)
      const sessionId = this.#snapshot.currentSessionId
      this.#writeQueue = this.#writeQueue.then(async () => {
        await this.#store.append(sessionId, record)
        this.#records.push(record)
      })
      this.#snapshot.transcript.push({ type: "message", turnId: this.#currentTurnId, message: event.record })
    }
    if (event.type === "compaction" && this.#snapshot.currentSessionId) {
      const firstKeptRecordId = this.#runtimeRecords.get(event.firstKeptRuntimeRef)
      if (!firstKeptRecordId) {
        this.#snapshot.lastError = "无法保存上下文压缩：找不到保留位置"
        this.#notify()
        return
      }
      const record: SessionRecord = {
        kind: "compaction",
        recordId: crypto.randomUUID(),
        at: new Date().toISOString(),
        summary: event.summary,
        firstKeptRecordId,
        tokensBefore: event.tokensBefore,
      }
      const sessionId = this.#snapshot.currentSessionId
      this.#writeQueue = this.#writeQueue.then(async () => {
        await this.#store.append(sessionId, record)
        this.#records.push(record)
      })
    }
    this.#notify()
  }

  #notify(): void {
    const snapshot = this.getSnapshot()
    for (const listener of this.#listeners) listener({ type: "snapshot", snapshot })
  }
}
