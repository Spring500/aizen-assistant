import { afterEach, expect } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { startMockServer } from "../utils/mock-server.ts"

const test = createDiagnosticTest({ timeoutMs: 10_000 })
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("OpenAI 多工具调用保持独立 ID、名称和参数", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-openai-tools-"))
  directories.push(root)
  const mock = await startMockServer({ modelBehaviors: { "openai-tools": "test-control" } })
  try {
    await writeFile(
      join(root, "custom-providers.json"),
      JSON.stringify({
        providers: {
          mock: {
            name: "OpenAI Mock",
            baseUrl: `${mock.url}/v1`,
            api: "openai-completions",
            models: [{ id: "openai-tools", name: "OpenAI Tools" }],
          },
        },
      }),
    )
    const pi = await PiSessionRuntime.create({
      authPath: join(root, "auth.json"),
      customProvidersPath: join(root, "custom-providers.json"),
    })
    await pi.setRuntimeApiKey("mock", "test-key")
    const model = (await pi.listModels()).find((item) => item.providerId === "mock" && item.modelId === "openai-tools")
    if (!model) throw new Error("缺少 OpenAI 完成协议测试模型")
    const calls: Array<{ callId: string; name: string; arguments: unknown }> = []
    pi.subscribe((event) => {
      if (event.type === "tool_started")
        calls.push({ callId: event.callId, name: event.name, arguments: event.arguments })
    })
    await pi.create({ cwd: root, model, view: { viewId: null, agentsFiles: [], skillPaths: [] } })
    const sending = pi.prompt({
      recordId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      viewId: null,
      items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "执行两个工具" }] }],
    })
    const first = await mock.take({ modelId: "openai-tools" })
    first.respond({
      type: "tool_calls",
      calls: [
        { name: "bash", arguments: { command: "echo one", declaredIntent: "输出第一项" }, callId: "openai-one" },
        { name: "bash", arguments: { command: "echo two", declaredIntent: "输出第二项" }, callId: "openai-two" },
      ],
    })
    const second = await mock.take({ modelId: "openai-tools" })
    const results = JSON.stringify(second.messages)
    expect(results).toContain("openai-one")
    expect(results).toContain("openai-two")
    expect(results).toContain("one")
    expect(results).toContain("two")
    second.respond({ type: "text", text: "工具完成" })
    await sending
    expect(calls).toContainEqual(
      expect.objectContaining({
        callId: "openai-one",
        name: "bash",
        arguments: { command: "echo one", declaredIntent: "输出第一项" },
      }),
    )
    expect(calls).toContainEqual(
      expect.objectContaining({
        callId: "openai-two",
        name: "bash",
        arguments: { command: "echo two", declaredIntent: "输出第二项" },
      }),
    )
    await pi.dispose()
  } finally {
    mock.stop()
  }
})
