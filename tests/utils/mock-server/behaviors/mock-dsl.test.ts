import { expect } from "bun:test"
import { createDiagnosticTest } from "../../diagnostic-test.ts"
import { startMockServer } from "../../mock-server.ts"
import type { MockRequestContext } from "../types.ts"
import { parseMockDsl } from "./dsl-parser.ts"
import { mockDslBehavior } from "./mock-dsl.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

function context(message: string, messages: MockRequestContext["messages"] = []): MockRequestContext {
  return {
    id: "request",
    sequence: 1,
    method: "POST",
    url: "http://mock/v1/messages",
    headers: {},
    protocol: "anthropic-messages",
    modelId: "mock-dsl",
    body: {},
    system: "",
    messages: [...messages, { role: "user", content: message }],
    tools: [],
    signal: new AbortController().signal,
  }
}

async function events(input: MockRequestContext) {
  const result = []
  for await (const event of mockDslBehavior(input)) result.push(event)
  return result
}

test("解析嵌套 edit 块并截断工具意图", () => {
  const parsed = parseMockDsl(`edit E1 ${"意图".repeat(30)} | config.json
<<<
old <<<
"enabled": false
>>>
new <<<
"enabled": true
>>>
>>>`)
  expect(parsed).toEqual({
    ok: true,
    instructions: [
      {
        type: "tool",
        callId: "E1",
        name: "edit",
        arguments: {
          path: "config.json",
          edits: [{ oldText: '"enabled": false', newText: '"enabled": true' }],
          declaredIntent: "意图".repeat(25),
        },
      },
    ],
  })
})

test("无效 DSL 原样回显", async () => {
  expect(await events(context("普通聊天内容"))).toEqual([
    { type: "text", text: "用户输入无法解析，原样输出结果如下：\n普通聊天内容" },
    { type: "finish", reason: "stop" },
  ])
})

test("工具结果引用自动切分轮次", async () => {
  const source = `bash T1 列出目录 | ls
text 目录：{{T1.Result}}`
  expect(await events(context(source))).toEqual([
    { type: "tool", callId: "T1", name: "bash", arguments: { command: "ls", declaredIntent: "列出目录" } },
    { type: "finish", reason: "toolUse" },
  ])
  expect(
    await events({
      ...context(source),
      messages: [
        { role: "user", content: source },
        { role: "assistant", content: "" },
        { role: "tool", toolCallId: "T1", toolName: "bash", content: "README.md" },
      ],
    }),
  ).toEqual([
    { type: "text", text: "目录：README.md" },
    { type: "finish", reason: "stop" },
  ])
})

test("已有工具结果时继续同轮剩余工具并保留引用切分", async () => {
  const source = `bash T1 第一项 | first
bash T2 第二项 | second
text {{T1.Result}} / {{T2.Result}}`
  expect(
    await events({
      ...context(source),
      messages: [
        { role: "user", content: source },
        { role: "assistant", content: "" },
        { role: "tool", toolCallId: "T1", toolName: "bash", content: "first-result" },
      ],
    }),
  ).toEqual([
    { type: "tool", callId: "T2", name: "bash", arguments: { command: "second", declaredIntent: "第二项" } },
    { type: "finish", reason: "toolUse" },
  ])
})

test("互不依赖的工具调用同轮发出", async () => {
  expect(
    await events(
      context(`bash T1 状态 | git status
read R1 读取说明 | README.md
text {{T1.Result}}`),
    ),
  ).toEqual([
    { type: "tool", callId: "T1", name: "bash", arguments: { command: "git status", declaredIntent: "状态" } },
    { type: "tool", callId: "R1", name: "read", arguments: { path: "README.md", declaredIntent: "读取说明" } },
    { type: "finish", reason: "toolUse" },
  ])
})

test("Mock Server 将 mock-dsl 注册为内置行为", async () => {
  const mock = await startMockServer(undefined, { strictModels: true })
  try {
    expect(mock.registeredModels()).toContain("mock-dsl")
    const response = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-dsl", messages: [{ role: "user", content: "text 已执行" }] }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("已执行")
  } finally {
    mock.stop()
  }
})
