import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import type { ModelReference } from "../../packages/core/session-format.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { startMockServer } from "../utils/mock-server.ts"

const directories: string[] = []

type StageDetails = () => Record<string, unknown>

async function traceStage<T>(name: string, operation: () => Promise<T>, details?: StageDetails): Promise<T> {
  const startedAt = performance.now()
  console.log(`[core-pi] 开始：${name}`)
  const diagnostics = [5000, 10000, 15000, 20000, 25000].map((delay) =>
    setTimeout(() => {
      const elapsed = Math.round(performance.now() - startedAt)
      const currentDetails = details?.()
      console.log(
        `[core-pi] 等待：${name}，已耗时 ${elapsed}ms${currentDetails ? `，状态 ${JSON.stringify(currentDetails)}` : ""}`,
      )
    }, delay),
  )
  try {
    const result = await operation()
    console.log(`[core-pi] 完成：${name}，耗时 ${Math.round(performance.now() - startedAt)}ms`)
    return result
  } catch (error) {
    console.error(
      `[core-pi] 失败：${name}，耗时 ${Math.round(performance.now() - startedAt)}ms，错误 ${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  } finally {
    for (const diagnostic of diagnostics) clearTimeout(diagnostic)
  }
}

function coreDetails(core: AizenCore): Record<string, unknown> {
  const snapshot = core.getSnapshot()
  return {
    status: snapshot.status,
    transcriptEntries: snapshot.transcript.length,
    activeTools: snapshot.activeTools.map((tool) => ({ name: tool.name, isFinished: tool.isFinished })),
    streamingTextLength: snapshot.streamingText.length,
    streamingThinkingLength: snapshot.streamingThinking.length,
    lastError: snapshot.lastError,
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("真实 pi 链路完成两轮并恢复第三轮", async () => {
  const root = await traceStage("创建临时目录", () => mkdtemp(join(tmpdir(), "aizen-integration-")))
  directories.push(root)
  const mock = await traceStage("启动 mock server", () => startMockServer("完成"))
  try {
    const pi = await traceStage("创建首次 pi runtime", () =>
      PiSessionRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null }),
    )
    await traceStage("配置首次 runtime 认证", () => pi.setRuntimeApiKey("anthropic", "test-key"))
    const models = await traceStage("读取首次 runtime 模型", () => pi.listModels())
    const option = models.find((item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6")
    expect(option).toBeDefined()
    if (!option) return
    const builtIn = { ...option, baseUrl: mock.url }
    pi.setModelBaseUrl(builtIn.providerId, builtIn.modelId, mock.url)
    console.log("[core-pi] 完成：配置首次 runtime mock 地址")
    const model: ModelReference = option
    const store = new SessionStore(join(root, "sessions"))
    const core = new AizenCore({ cwd: root, store, pi })
    const createResult = await traceStage(
      "创建会话",
      () => core.dispatch({ type: "create_session", model, viewId: null }),
      () => coreDetails(core),
    )
    expect(createResult.ok).toBe(true)
    const sessionId = core.getSnapshot().currentSessionId
    const firstResult = await traceStage(
      "发送第一轮",
      () => core.dispatch({ type: "send_prompt", text: "第一轮" }),
      () => coreDetails(core),
    )
    expect(firstResult.ok).toBe(true)
    const secondResult = await traceStage(
      "发送第二轮",
      () => core.dispatch({ type: "send_prompt", text: "第二轮" }),
      () => coreDetails(core),
    )
    expect(secondResult.ok).toBe(true)
    await traceStage(
      "释放首次 core",
      () => core.dispose(),
      () => coreDetails(core),
    )

    const restoredPi = await traceStage("创建恢复 pi runtime", () =>
      PiSessionRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null }),
    )
    await traceStage("配置恢复 runtime 认证", () => restoredPi.setRuntimeApiKey("anthropic", "test-key"))
    restoredPi.setModelBaseUrl(option.providerId, option.modelId, mock.url)
    console.log("[core-pi] 完成：配置恢复 runtime mock 地址")
    const restored = new AizenCore({ cwd: root, store, pi: restoredPi })
    const openResult = await traceStage(
      "恢复会话",
      () => restored.dispatch({ type: "open_session", sessionId: sessionId ?? "" }),
      () => coreDetails(restored),
    )
    expect(openResult.ok).toBe(true)
    const thirdResult = await traceStage(
      "发送第三轮",
      () => restored.dispatch({ type: "send_prompt", text: "第三轮" }),
      () => coreDetails(restored),
    )
    expect(thirdResult.ok).toBe(true)
    await traceStage(
      "释放恢复 core",
      () => restored.dispose(),
      () => coreDetails(restored),
    )

    const requests = await traceStage("读取 mock 请求记录", () => mock.requests())
    console.log(`[core-pi] 完成：校验请求记录，共 ${requests.length} 条`)
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[1])).toContain("第一轮")
    expect(JSON.stringify(requests[2])).toContain("第二轮")
  } finally {
    mock.stop()
  }
}, 30000)
