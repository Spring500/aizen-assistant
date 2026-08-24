import { expect } from "bun:test"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { startMockServer } from "./mock-server.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

test("OpenAI 协议归一化请求并输出指定工具调用 ID", async () => {
  const mock = await startMockServer({ modelBehaviors: { "openai-mock": "test-control" } })
  try {
    const completing = fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai-mock",
        stream: true,
        messages: [{ role: "user", content: "发起调用" }],
        tools: [{ type: "function", function: { name: "echo", description: "回显", parameters: { type: "object" } } }],
      }),
    })
    const request = await mock.take({ modelId: "openai-mock" })
    expect(request.protocol).toBe("openai-completions")
    expect(request.messages).toContainEqual({ role: "user", content: "发起调用" })
    expect(request.tools).toContainEqual(
      expect.objectContaining({ function: expect.objectContaining({ name: "echo" }) }),
    )
    request.respond({
      type: "tool_calls",
      calls: [
        { name: "echo", arguments: { text: "内容一" }, callId: "openai-call-one" },
        { name: "echo", arguments: { text: "内容二" }, callId: "openai-call-two" },
      ],
    })
    const body = await (await completing).text()
    expect(body).toContain('"id":"openai-call-one"')
    expect(body).toContain('"id":"openai-call-two"')
    expect(body).toContain('"index":0')
    expect(body).toContain('"index":1')
    expect(body).toContain('"finish_reason":"tool_calls"')
  } finally {
    mock.stop()
  }
})

test("Anthropic Mock 按与 pi 一致的字符近似报告输入 token", async () => {
  const mock = await startMockServer({ modelBehaviors: { "anthropic-usage": "test-control" } })
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
  await runtime.setRuntimeApiKey("anthropic", "test-key")
  const anthropic = runtime.getModel("anthropic", "claude-sonnet-4-6")
  if (!anthropic) throw new Error("找不到测试模型")
  const longChinese = "长上下文".repeat(6000)
  mock.handle(() => ({ type: "text", text: "完成" }))
  try {
    const anthropicResult = await runtime.completeSimple(
      { ...anthropic, id: "anthropic-usage", baseUrl: mock.url },
      { messages: [{ role: "user", content: longChinese, timestamp: Date.now() }] },
    )
    expect(anthropicResult.usage.input).toBeGreaterThan(6000)
    expect(anthropicResult.usage.input).toBeLessThan(8000)
  } finally {
    mock.stop()
  }
})

test("未知内置 Mock 模型返回可诊断的 404", async () => {
  const mock = await startMockServer()
  try {
    const response = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-not-registered", messages: [] }),
    })
    expect(response.status).toBe(404)
    expect(await response.text()).toContain("mock-not-registered")
  } finally {
    mock.stop()
  }
})
