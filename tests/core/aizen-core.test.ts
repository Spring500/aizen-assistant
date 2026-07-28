import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import type { PiPort, PiPortEvent } from "../../packages/core/pi-port.ts"
import type { ModelReference } from "../../packages/core/session-format.ts"
import { ModelConfigStore } from "../../packages/core/model-config-store.ts"
import { SessionStore } from "../../packages/core/session-store.ts"

const model: ModelReference = { providerId: "test", modelId: "model", api: "anthropic-messages", thinkingLevel: "off" }
const directories: string[] = []

class FakePi implements PiPort {
  listeners = new Set<(event: PiPortEvent) => void>()
  prompts: unknown[] = []
  create = async () => model
  restore = async () => model
  refreshView = async () => {}
  switchView = async () => model
  abort = async () => {}
  listModels = async () => [{ ...model, name: "测试模型", available: true }]
  reloadModelConfig = async () => {}
  setModel = async () => model
  listAuthProviders = async () => []
  loginApiKey = async () => {}
  answerAuthPrompt = () => {}
  cancelAuth = () => {}
  dispose = async () => {}
  subscribe(listener: (event: PiPortEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async prompt(input: unknown) {
    this.prompts.push(input)
    for (const listener of this.listeners) {
      listener({ type: "text_delta", delta: "完成" })
      listener({
        type: "message",
        runtimeRef: crypto.randomUUID(),
        record: {
          role: "assistant",
          parts: [{ kind: "text", text: "完成" }],
          source: { providerId: "test", modelId: "model", api: "anthropic-messages" },
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      })
      listener({ type: "settled" })
    }
  }
}

class CompactingFakePi extends FakePi {
  async prompt(input: { recordId: string }) {
    for (const listener of this.listeners) {
      listener({
        type: "message",
        runtimeRef: "pi-message-id",
        record: {
          role: "assistant",
          parts: [{ kind: "text", text: "完成" }],
          source: { providerId: "test", modelId: "model", api: "anthropic-messages" },
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      })
      listener({
        type: "compaction",
        summary: "摘要",
        firstKeptRuntimeRef: "pi-message-id",
        tokensBefore: 100,
      })
      listener({ type: "settled" })
    }
    this.prompts.push(input)
  }
}

class FailingFakePi extends FakePi {
  async prompt() {
    for (const listener of this.listeners) {
      listener({
        type: "message",
        runtimeRef: "failed-message",
        record: {
          role: "assistant",
          parts: [],
          source: { providerId: "test", modelId: "model", api: "anthropic-messages" },
          stopReason: "error",
          errorMessage: "服务不可用",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      })
      listener({ type: "settled" })
    }
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("核心编排", () => {
  test("模型配置变更重载运行时并保护当前模型", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const pi = new FakePi()
    const config = new ModelConfigStore(join(root, "models.json"))
    const core = new AizenCore({
      cwd: "E:\\project",
      store: new SessionStore(join(root, "sessions")),
      pi,
      modelConfigStore: config,
    })

    await core.dispatch({ type: "load_model_config" })
    let revision = core.getSnapshot().modelConfig?.revision ?? ""
    expect(
      await core.dispatch({
        type: "save_provider",
        revision,
        provider: {
          id: "company",
          name: "公司网关",
          baseUrl: "https://example.com/v1",
          api: "openai-completions",
          authHeader: true,
        },
        create: true,
      }),
    ).toEqual({ ok: true })
    revision = core.getSnapshot().modelConfig?.revision ?? ""
    expect(
      await core.dispatch({
        type: "save_model",
        revision,
        providerId: "company",
        model: {
          id: "model-a",
          name: "模型 A",
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 16000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        create: true,
      }),
    ).toEqual({ ok: true })
    expect(core.getSnapshot().modelConfig?.providers[0]?.models[0]?.id).toBe("model-a")

    await core.dispatch({ type: "create_session", model })
    revision = core.getSnapshot().modelConfig?.revision ?? ""
    expect(await core.dispatch({ type: "delete_model", revision, providerId: "test", modelId: "model" })).toEqual({
      ok: false,
      error: "不能删除当前会话正在使用的模型，请先切换模型",
    })
    await core.dispose()
  })

  test("核心保留工具参数并更新流式输出预览", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const pi = new FakePi()
    const core = new AizenCore({ cwd: "E:\\project", store: new SessionStore(root), pi })

    for (const listener of pi.listeners) {
      listener({ type: "tool_started", callId: "c1", name: "bash", arguments: { command: "bun test" } })
      listener({ type: "tool_updated", callId: "c1", name: "bash", output: "第一行\n最后一行" })
    }

    expect(core.getSnapshot().activeTools).toEqual([
      {
        callId: "c1",
        name: "bash",
        arguments: { command: "bun test" },
        outputPreview: "第一行\n最后一行",
      },
    ])
    await core.dispose()
  })

  test("认证选择事件保留候选项", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const pi = new FakePi()
    const core = new AizenCore({ cwd: "E:\\project", store: new SessionStore(root), pi })
    const events: unknown[] = []
    core.subscribe((event) => events.push(event))

    for (const listener of pi.listeners) {
      listener({
        type: "auth_prompt",
        promptId: "prompt",
        promptType: "select",
        message: "选择认证方式",
        options: [{ id: "token", label: "令牌" }],
      })
    }

    expect(events).toContainEqual({
      type: "auth_prompt",
      promptId: "prompt",
      promptType: "select",
      message: "选择认证方式",
      options: [{ id: "token", label: "令牌" }],
    })
    await core.dispose()
  })

  test("新建、发送多轮并从文件恢复", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const pi = new FakePi()
    const core = new AizenCore({ cwd: "E:\\project", store, pi })

    expect(await core.dispatch({ type: "create_session", model })).toEqual({ ok: true })
    const sessionId = core.getSnapshot().currentSessionId
    expect(sessionId).toBeDefined()
    expect(await core.dispatch({ type: "send_prompt", text: "第一轮" })).toEqual({ ok: true })
    expect(await core.dispatch({ type: "send_prompt", text: "第二轮" })).toEqual({ ok: true })
    expect(pi.prompts).toHaveLength(2)
    await core.dispose()

    const restoredPi = new FakePi()
    const restored = new AizenCore({ cwd: "E:\\project", store, pi: restoredPi })
    expect(await restored.dispatch({ type: "open_session", sessionId: sessionId ?? "" })).toEqual({ ok: true })
    expect(restored.getSnapshot().transcript.filter((entry) => entry.type === "turn_end")).toHaveLength(2)
    await restored.dispose()
  })

  test("额外消息先写入会话且 useLater 语义交给适配器", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const pi = new FakePi()
    const core = new AizenCore({
      cwd: "E:\\project",
      store,
      pi,
      extraMessages: async () => [
        {
          source: "clock",
          role: "developer",
          useLater: false,
          parts: [{ kind: "text", text: "仅本轮" }],
        },
      ],
    })

    await core.dispatch({ type: "create_session", model })
    const sessionId = core.getSnapshot().currentSessionId ?? ""
    await core.dispatch({ type: "send_prompt", text: "用户消息" })
    const loaded = await store.read(sessionId)
    const started = loaded.records.find((record) => record.kind === "turn_started")
    expect(started?.kind === "turn_started" ? started.items : []).toEqual([
      { source: "clock", role: "developer", useLater: false, parts: [{ kind: "text", text: "仅本轮" }] },
      { source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "用户消息" }] },
    ])
    expect(pi.prompts[0]).toMatchObject({ items: started?.kind === "turn_started" ? started.items : [] })
    await core.dispose()
  })

  test("上下文压缩只保存核心记录 ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const core = new AizenCore({ cwd: "E:\\project", store, pi: new CompactingFakePi() })

    await core.dispatch({ type: "create_session", model })
    const sessionId = core.getSnapshot().currentSessionId ?? ""
    await core.dispatch({ type: "send_prompt", text: "触发压缩" })
    await core.dispose()

    const loaded = await store.read(sessionId)
    const message = loaded.records.find((record) => record.kind === "message")
    const compaction = loaded.records.find((record) => record.kind === "compaction")
    expect(message?.kind).toBe("message")
    expect(compaction?.kind).toBe("compaction")
    if (message?.kind === "message" && compaction?.kind === "compaction") {
      expect(compaction.firstKeptRecordId).toBe(message.recordId)
      expect(JSON.stringify(compaction)).not.toContain("pi-message-id")
    }
  })

  test("模型错误写入失败轮次并恢复空闲", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const core = new AizenCore({ cwd: "E:\\project", store, pi: new FailingFakePi() })

    await core.dispatch({ type: "create_session", model })
    const sessionId = core.getSnapshot().currentSessionId ?? ""
    expect((await core.dispatch({ type: "send_prompt", text: "失败请求" })).ok).toBe(true)
    const loaded = await store.read(sessionId)
    const finished = loaded.records.find((record) => record.kind === "turn_finished")
    expect(finished).toMatchObject({ kind: "turn_finished", outcome: "failed" })
    expect(finished?.kind === "turn_finished" ? finished.error?.message : undefined).toBe("服务不可用")
    expect(core.getSnapshot().status).toBe("idle")
    await core.dispose()
  })
})
