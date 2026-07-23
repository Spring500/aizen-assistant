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

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("真实 pi 链路完成两轮并恢复第三轮", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-integration-"))
  directories.push(root)
  const mock = await startMockServer("完成")
  try {
    const pi = await PiSessionRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null })
    await pi.setRuntimeApiKey("anthropic", "test-key")
    const option = (await pi.listModels()).find(
      (item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6",
    )
    expect(option).toBeDefined()
    if (!option) return
    const builtIn = { ...option, baseUrl: mock.url }
    pi.setModelBaseUrl(builtIn.providerId, builtIn.modelId, mock.url)
    const model: ModelReference = option
    const store = new SessionStore(join(root, "sessions"))
    const core = new AizenCore({ cwd: root, store, pi })
    await core.dispatch({ type: "create_session", model })
    const sessionId = core.getSnapshot().currentSessionId
    expect((await core.dispatch({ type: "send_prompt", text: "第一轮" })).ok).toBe(true)
    expect((await core.dispatch({ type: "send_prompt", text: "第二轮" })).ok).toBe(true)
    await core.dispose()

    const restoredPi = await PiSessionRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null })
    await restoredPi.setRuntimeApiKey("anthropic", "test-key")
    restoredPi.setModelBaseUrl(option.providerId, option.modelId, mock.url)
    const restored = new AizenCore({ cwd: root, store, pi: restoredPi })
    expect((await restored.dispatch({ type: "open_session", sessionId: sessionId ?? "" })).ok).toBe(true)
    expect((await restored.dispatch({ type: "send_prompt", text: "第三轮" })).ok).toBe(true)
    await restored.dispose()

    const requests = await mock.requests()
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[1])).toContain("第一轮")
    expect(JSON.stringify(requests[2])).toContain("第二轮")
  } finally {
    mock.stop()
  }
}, 30000)
