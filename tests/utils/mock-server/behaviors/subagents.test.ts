import { expect } from "bun:test"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { createDiagnosticTest } from "../../diagnostic-test.ts"
import { startMockServer } from "../../mock-server.ts"

const test = createDiagnosticTest({ timeoutMs: 10_000 })

async function setup() {
  const mock = await startMockServer(undefined, { strictModels: true })
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
  await runtime.setRuntimeApiKey("anthropic", "test-key")
  const source = runtime.getModel("anthropic", "claude-sonnet-4-6")
  if (!source) throw new Error("找不到 Anthropic 测试模型")
  return { mock, runtime, source }
}

test("mock-naming 生成符合工具契约的标题", async () => {
  const { mock, runtime, source } = await setup()
  try {
    const result = await runtime.completeSimple(
      { ...source, id: "mock-naming", baseUrl: mock.url },
      { messages: [{ role: "user", content: "   整理    自举套件   文档  ", timestamp: Date.now() }] },
    )
    expect(result.content).toContainEqual(
      expect.objectContaining({
        type: "toolCall",
        id: "set_session_title",
        name: "set_session_title",
        arguments: { title: expect.stringMatching(/^\[\d{4}-\d{4}\] 整理 自举套件 文档$/) },
      }),
    )
  } finally {
    mock.stop()
  }
})

test("mock-naming 始终生成不超过 80 字符的单行标题", async () => {
  const { mock, runtime, source } = await setup()
  try {
    const result = await runtime.completeSimple(
      { ...source, id: "mock-naming", baseUrl: mock.url },
      { messages: [{ role: "user", content: "关键字".repeat(100), timestamp: Date.now() }] },
    )
    const call = result.content.find((part) => part.type === "toolCall")
    if (!call || typeof call.arguments.title !== "string") throw new Error("缺少标题工具调用")
    expect(call.arguments.title.includes("\n")).toBe(false)
    expect(Array.from(call.arguments.title)).toHaveLength(80)
  } finally {
    mock.stop()
  }
})

test("mock-review 按意图暗语输出三种权限裁决", async () => {
  const { mock, runtime, source } = await setup()
  try {
    for (const [intent, decision] of [
      ["[通过] 读取配置", "allow"],
      ["[拒绝] 删除文件", "deny"],
      ["检查状态", "needHumanReview"],
    ] as const) {
      const result = await runtime.completeSimple(
        { ...source, id: "mock-review", baseUrl: mock.url },
        { messages: [{ role: "user", content: JSON.stringify({ declaredIntent: intent }), timestamp: Date.now() }] },
      )
      expect(result.content).toContainEqual(
        expect.objectContaining({
          type: "toolCall",
          id: "submit_permission_review",
          name: "submit_permission_review",
          arguments: expect.objectContaining({ decision, reason: expect.any(String) }),
        }),
      )
    }
  } finally {
    mock.stop()
  }
})
