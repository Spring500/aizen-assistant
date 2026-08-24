import { expect } from "bun:test"
import { createDiagnosticTest } from "../../diagnostic-test.ts"
import { startMockServer } from "../../mock-server.ts"
import type { MockRequestContext } from "../types.ts"
import { mockSummaryBehavior } from "./mock-summary.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const summarySystem = `You are a context summarization assistant. Your task is to read a conversation.
ONLY output the structured summary.`

function summaryPrompt(conversation: string): string {
  return `<conversation>\n${conversation}\n</conversation>\n\nCreate a structured context checkpoint summary.`
}

function context(conversation: string): MockRequestContext {
  return {
    id: "summary-request",
    sequence: 1,
    method: "POST",
    url: "http://mock/v1/messages",
    headers: {},
    protocol: "anthropic-messages",
    modelId: "mock-dsl",
    rawBody: {},
    rawMessages: [],
    system: summarySystem,
    messages: [{ role: "user", content: summaryPrompt(conversation) }],
    tools: [],
    signal: new AbortController().signal,
  }
}

async function responseText(input: MockRequestContext): Promise<string> {
  const chunks: string[] = []
  for await (const event of mockSummaryBehavior(input)) if (event.type === "text") chunks.push(event.text)
  return chunks.join("")
}

test("摘要列出段数、字符数及首末段缩略且不复制长原文", async () => {
  const hidden = "不应进入摘要的中段标记"
  const conversation = [
    `[User]: 第一段 ${"甲".repeat(120)}`,
    `[Assistant thinking]: 正在分析`,
    `[Assistant]: 中间回复 ${hidden}`,
    `[Tool result]: 最后一段 ${"乙".repeat(120)}`,
  ].join("\n\n")
  const text = await responseText(context(conversation))

  expect(text).toContain("已压缩 4 段（用户 1、助手 1、助手思考 1、助手工具调用 0、工具结果 1）")
  expect(text).toContain(`压缩原文共 ${Array.from(conversation).length} 个 Unicode 字符`)
  expect(text).toContain("首段（用户）：“第一段")
  expect(text).toContain("末段（工具结果）：“最后一段")
  expect(text).not.toContain(hidden)
  expect(Array.from(text).length).toBeLessThanOrEqual(700)
})

test("Anthropic 与 OpenAI 内置模型都优先处理摘要请求", async () => {
  const mock = await startMockServer()
  try {
    const conversation = `[User]: 首段内容\n\n[Assistant]: 末段内容`
    const requests = [
      fetch(`${mock.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mock-dsl",
          system: summarySystem,
          messages: [{ role: "user", content: summaryPrompt(conversation) }],
        }),
      }),
      fetch(`${mock.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mock-dsl",
          messages: [
            { role: "system", content: summarySystem },
            { role: "user", content: summaryPrompt(conversation) },
          ],
        }),
      }),
    ]

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain("已压缩 2 段")
      expect(body).toContain("首段（用户）")
      expect(body).not.toContain("用户输入无法解析")
    }
  } finally {
    mock.stop()
  }
})
