import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { startMockServer } from "./mock-server.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

test("OpenAI 协议归一化请求并输出指定工具调用 ID", async () => {
  const mock = await startMockServer()
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
    expect(request.tools).toContainEqual(expect.objectContaining({ name: "echo" }))
    request.respond({ type: "tool_call", name: "echo", arguments: { text: "内容" }, callId: "openai-call" })
    const body = await (await completing).text()
    expect(body).toContain('"id":"openai-call"')
    expect(body).toContain('"name":"echo"')
    expect(body).toContain('"finish_reason":"tool_calls"')
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
