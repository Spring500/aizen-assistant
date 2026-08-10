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
 * 复现 bug：autoApprove 会话中，模型某次返回超过 50 个字符的 declaredIntent。
 * 预期（bug 现象）：
 * 1. 该次助手消息落盘校验失败 → #writeError 置位；
 * 2. 该轮次内工具执行的审计记录也被 #writeError 挡住 → 工具调用失败；
 * 3. 模型在同轮次内继续调用工具（即使 declaredIntent 正常）也全部失败；
 * 4. 下一轮用户输入被"会话持久化异常"拒绝；
 * 5. 会话文件未写入任何失败消息（无现场记录）。
 */
test("超长 declaredIntent 一次触发后：同轮次调用全部失败且后续无法继续", async () => {
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

    // 模型看到工具失败后，在同一轮次内继续调用工具（这次 declaredIntent 正常）
    const second = await mock.take({ modelId: option.modelId })
    second.respond({
      type: "tool_call",
      name: "bash",
      arguments: { command: "echo world", declaredIntent: "回显测试" },
      callId: "call-normal",
    })

    // 模型再次看到失败后，收尾结束本轮
    const third = await mock.take({ modelId: option.modelId })
    third.respond({ type: "text", text: "完成" })

    const firstRound = await sending
    console.log("第一轮结果:", JSON.stringify(firstRound))
    console.log("lastError:", core.getSnapshot().lastError)
    expect(firstRound.ok).toBe(false)
    expect(String(firstRound.error?.message ?? "")).toContain("工具调用内容块.declaredIntent 必须为 1 至 50 个字符")

    // 会话文件必须没有留下失败消息（出问题时无现场记录）
    const loaded = await store.read(sessionId)
    const messages = loaded.records.filter((record) => record.kind === "message")
    expect(messages).toHaveLength(0)

    // 下一轮用户输入被拒绝
    const secondRound = await core.dispatch({ type: "send_prompt", text: "继续" })
    console.log("第二轮结果:", JSON.stringify(secondRound))
    expect(secondRound.ok).toBe(false)
    expect(String(secondRound.error?.message ?? "")).toContain("会话持久化异常，请重新打开会话")
    await core.dispose()
  } finally {
    mock.stop()
  }
})
