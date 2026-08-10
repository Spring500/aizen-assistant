import { afterEach, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { startMockServer } from "../utils/mock-server.ts"

const test = createDiagnosticTest({ timeoutMs: 30_000 })
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/**
 * 回归验证：autoApprove 会话中模型返回超过 50 个字符的 declaredIntent 时，
 * 落盘前应被截断为 50 码点，工具正常执行、会话不被锁死、下一轮可继续输入。
 */
test("超长 declaredIntent 被截断保存且不锁死会话", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-repro-intent-"))
  directories.push(root)
  const mock = await startMockServer()
  try {
    const pi = await PiSessionRuntime.create({ authPath: join(root, "auth.json"), customProvidersPath: null })
    await pi.setRuntimeApiKey("anthropic", "test-key")
    const option = (await pi.listModels()).find(
      (item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6",
    )
    if (!option) throw new Error("缺少集成测试模型")
    pi.setModelBaseUrl(option.providerId, option.modelId, mock.url)
    const store = new SessionStore(join(root, "sessions"))
    const core = new AizenCore({ cwd: root, store, pi })
    await core.dispatch({
      type: "create_session",
      model: option,
      viewId: null,
      permissionMode: "hybrid",
      permissionPreset: "edit",
      permissionReviewMode: "autoApprove",
    })
    const sessionId = core.getSnapshot().currentSessionId ?? ""

    const sending = core.dispatch({ type: "send_prompt", text: "执行测试" })

    // 第一次工具调用：模型返回超长 declaredIntent（>50 码点）
    const first = await mock.take({ modelId: option.modelId })
    first.respond({
      type: "tool_call",
      name: "bash",
      arguments: { command: "echo hi", declaredIntent: "用".repeat(51) },
      callId: "call-overflow",
    })

    // 工具成功后模型继续：第二次调用 declaredIntent 正常
    const second = await mock.take({ modelId: option.modelId })
    second.respond({
      type: "tool_call",
      name: "bash",
      arguments: { command: "echo world", declaredIntent: "回显测试" },
      callId: "call-normal",
    })

    // 模型收尾结束本轮
    const third = await mock.take({ modelId: option.modelId })
    third.respond({ type: "text", text: "完成" })

    const firstRound = await sending
    console.log("第一轮结果:", JSON.stringify(firstRound))
    console.log("lastError:", core.getSnapshot().lastError)
    expect(firstRound.ok).toBe(true)
    expect(core.getSnapshot().lastError).toBeUndefined()

    // 会话文件应保存两条 assistant 消息：超长被截断为 50 码点，正常值原样保留
    const loaded = await store.read(sessionId)
    const assistantCalls = loaded.records
      .filter((record) => record.kind === "message")
      .map((record) => (record.kind === "message" ? record.message : null))
      .filter((message): message is { role: "assistant"; parts: Array<{ kind: string; declaredIntent?: string }> } =>
        !!message && message.role === "assistant" && Array.isArray(message.parts),
      )
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === "tool_call")
    expect(assistantCalls).toHaveLength(2)
    expect(assistantCalls[0]?.declaredIntent).toBe("用".repeat(50))
    expect(assistantCalls[1]?.declaredIntent).toBe("回显测试")

    // 下一轮用户输入正常（会话未被锁死）
    const secondRoundSending = core.dispatch({ type: "send_prompt", text: "继续" })
    const fourth = await mock.take({ modelId: option.modelId })
    fourth.respond({ type: "text", text: "收到" })
    const secondRound = await secondRoundSending
    console.log("第二轮结果:", JSON.stringify(secondRound))
    expect(secondRound.ok).toBe(true)
    await core.dispose()
  } finally {
    mock.stop()
  }
})
