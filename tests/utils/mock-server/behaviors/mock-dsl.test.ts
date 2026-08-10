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
    rawBody: {},
    rawMessages: [],
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

test("无效 DSL 原样回显并包含解析错误", async () => {
  expect(await events(context("普通聊天内容"))).toEqual([
    {
      type: "text",
      text: "用户输入无法解析，原样输出结果如下：\n普通聊天内容\n\n解析错误：\n无法识别的指令：普通聊天内容",
    },
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

test("引用仅在思考和正文中生效", async () => {
  const source = `bash T1 获取内容 | echo '"result"'
write W1 写入字面量 | result.txt
<<<
{{T1.Result}}
>>>
text 结果：{{T1.Result}}`
  expect(await events(context(source))).toEqual([
    {
      type: "tool",
      callId: "T1",
      name: "bash",
      arguments: { command: "echo '\"result\"'", declaredIntent: "获取内容" },
    },
    {
      type: "tool",
      callId: "W1",
      name: "write",
      arguments: { path: "result.txt", content: "{{T1.Result}}", declaredIntent: "写入字面量" },
    },
    { type: "finish", reason: "toolUse" },
  ])
  expect(
    await events({
      ...context(source),
      messages: [
        { role: "user", content: source },
        { role: "assistant", content: "" },
        { role: "tool", toolCallId: "T1", toolName: "bash", content: '他说："成功"' },
        { role: "tool", toolCallId: "W1", toolName: "write", content: "已写入" },
      ],
    }),
  ).toEqual([
    { type: "text", text: '结果：他说："成功"' },
    { type: "finish", reason: "stop" },
  ])
})

test("拒绝未声明引用和不合法终止指令组合", () => {
  expect(parseMockDsl("text {{T1.Result}}")).toEqual({ ok: false, reason: "引用了尚未声明的工具调用：T1" })
  expect(parseMockDsl("think 正在处理\nerror 500 失败")).toEqual({
    ok: false,
    reason: "error 作为 HTTP 错误前只能使用 delay",
  })
  expect(parseMockDsl("disconnect 已断开\ntext 不可达")).toEqual({
    ok: false,
    reason: "error、disconnect 和 hang 必须是最后一条指令",
  })
  expect(parseMockDsl("hang\ntext 不可达")).toEqual({
    ok: false,
    reason: "error、disconnect 和 hang 必须是最后一条指令",
  })
})

test("合法的 delay 加 HTTP 错误保持首事件语义", async () => {
  expect(await events(context("delay 0\nerror 500 上游失败"))).toEqual([
    { type: "error", status: 500, message: "上游失败" },
  ])
})

test("思考后可通过 disconnect 模拟流中异常", async () => {
  expect(await events(context("think 正在处理\ndelay 0\ndisconnect 上游连接中断"))).toEqual([
    { type: "thinking", text: "正在处理" },
    { type: "disconnect", message: "上游连接中断" },
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
  const mock = await startMockServer()
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
