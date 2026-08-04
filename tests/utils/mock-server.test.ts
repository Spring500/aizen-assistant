import { afterEach, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { startMockServer, type MockServer } from "./mock-server.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const servers: MockServer[] = []

async function setup() {
  const mock = await startMockServer()
  servers.push(mock)
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
  await runtime.setRuntimeApiKey("anthropic", "test-key")
  const source = runtime.getModel("anthropic", "claude-sonnet-4-6")
  if (!source) throw new Error("找不到测试模型")
  return { mock, runtime, source }
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

test("take 捕获完整请求并由测试显式响应", async () => {
  const { mock, runtime, source } = await setup()
  const model = { ...source, id: "title-model", baseUrl: mock.url }
  const completing = runtime.completeSimple(model, {
    systemPrompt: "命名系统提示",
    messages: [{ role: "user", content: "第一句话", timestamp: Date.now() }],
    tools: [{ name: "set_session_title", description: "设置标题", parameters: { type: "object" } }],
  })
  const request = await mock.take({ modelId: "title-model" })
  expect(request.modelId).toBe("title-model")
  expect(JSON.stringify(request.system)).toContain("命名系统提示")
  expect(JSON.stringify(request.messages)).toContain("第一句话")
  expect(JSON.stringify(request.tools)).toContain("set_session_title")
  request.respond({ type: "tool_call", name: "set_session_title", arguments: { title: "第一句标题" } })
  const result = await completing
  expect(result.content).toContainEqual(
    expect.objectContaining({ type: "toolCall", name: "set_session_title", arguments: { title: "第一句标题" } }),
  )
})

test("模型 Lambda Handler 持续处理指定模型", async () => {
  const { mock, runtime, source } = await setup()
  let count = 0
  mock.handleModel("chat-model", (request) => ({
    type: "text",
    text: `${request.modelId}:${++count}`,
  }))
  const model = { ...source, id: "chat-model", baseUrl: mock.url }
  const first = await runtime.completeSimple(model, {
    messages: [{ role: "user", content: "一", timestamp: Date.now() }],
  })
  const second = await runtime.completeSimple(model, {
    messages: [{ role: "user", content: "二", timestamp: Date.now() }],
  })
  expect(first.content).toContainEqual(expect.objectContaining({ type: "text", text: "chat-model:1" }))
  expect(second.content).toContainEqual(expect.objectContaining({ type: "text", text: "chat-model:2" }))
  expect(await mock.requests()).toHaveLength(2)
})
