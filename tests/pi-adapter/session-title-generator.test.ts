import { afterEach, expect, test } from "bun:test"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { generateSessionTitle } from "../../packages/pi-adapter/session-title-generator.ts"
import { startMockServer, type MockServer } from "../utils/mock-server.ts"

const servers: MockServer[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

async function setup() {
  const mock = await startMockServer()
  servers.push(mock)
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
  await runtime.setRuntimeApiKey("anthropic", "test-key")
  const source = runtime.getModel("anthropic", "claude-sonnet-4-6")
  if (!source) throw new Error("找不到命名测试模型")
  return { mock, runtime, model: { ...source, id: "title-model", baseUrl: mock.url } }
}

test("命名模型通过专用工具返回标题", async () => {
  const { mock, runtime, model } = await setup()
  const generating = generateSessionTitle(runtime, model, "分析 OpenCode 自动命名")
  const request = await mock.take({ modelId: "title-model" })
  expect(JSON.stringify(request.messages)).toContain("分析 OpenCode 自动命名")
  expect(JSON.stringify(request.tools)).toContain("set_session_title")
  request.respond({ type: "tool_call", name: "set_session_title", arguments: { title: "OpenCode 自动命名分析" } })
  expect(await generating).toBe("OpenCode 自动命名分析")
})

test("协议错误反馈给模型并最多提供三次机会", async () => {
  const { mock, runtime, model } = await setup()
  const generating = generateSessionTitle(runtime, model, "第一句话")
  const first = await mock.take({ modelId: "title-model" })
  first.respond({ type: "text", text: "直接输出标题" })
  const second = await mock.take({ modelId: "title-model" })
  expect(JSON.stringify(second.messages)).toContain("没有调用 set_session_title")
  second.respond({ type: "tool_call", name: "set_session_title", arguments: {} })
  const third = await mock.take({ modelId: "title-model" })
  expect(JSON.stringify(third.messages)).toContain("缺少字符串参数 title")
  third.respond({ type: "tool_call", name: "set_session_title", arguments: { title: "修正后的标题" } })
  expect(await generating).toBe("修正后的标题")
})

test("三次协议错误后返回明确失败", async () => {
  const { mock, runtime, model } = await setup()
  const generating = generateSessionTitle(runtime, model, "第一句话")
  for (let attempt = 0; attempt < 3; attempt++) {
    const request = await mock.take({ modelId: "title-model" })
    request.respond({ type: "text", text: "仍未调用工具" })
  }
  await expect(generating).rejects.toThrow("连续 3 次未正确提交标题")
  expect(await mock.requests()).toHaveLength(3)
})
