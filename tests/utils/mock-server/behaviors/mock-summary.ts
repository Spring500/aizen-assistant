import type { MockBehavior, MockEvent, MockMessage, MockRequestContext } from "../types.ts"

const summarizationSystemMarkers = [
  "You are a context summarization assistant",
  "ONLY output the structured summary",
] as const
const conversationStart = "<conversation>"
const conversationEnd = "</conversation>"
const previewLimit = 80

type SegmentKind = "用户" | "助手" | "助手思考" | "助手工具调用" | "工具结果"

type Segment = {
  kind: SegmentKind
  content: string
}

const segmentKinds: Record<string, SegmentKind> = {
  User: "用户",
  Assistant: "助手",
  "Assistant thinking": "助手思考",
  "Assistant tool calls": "助手工具调用",
  "Tool result": "工具结果",
}

/** 判断归一化请求是否为 pi 发起的上下文摘要请求。 */
export function isSummarizationRequest(context: MockRequestContext): boolean {
  return summarizationSystemMarkers.every((marker) => context.system.includes(marker))
}

function lastUserMessage(messages: MockMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === "user") return message.content
  }
  return ""
}

function extractConversation(prompt: string): string {
  const start = prompt.indexOf(conversationStart)
  const end = prompt.lastIndexOf(conversationEnd)
  if (start < 0 || end < start + conversationStart.length) return ""
  let conversation = prompt.slice(start + conversationStart.length, end)
  if (conversation.startsWith("\n")) conversation = conversation.slice(1)
  if (conversation.endsWith("\n")) conversation = conversation.slice(0, -1)
  return conversation
}

function parseSegments(conversation: string): Segment[] {
  const pattern = /(?:^|\n\n)\[(User|Assistant thinking|Assistant|Assistant tool calls|Tool result)\]:\s*/g
  const matches = [...conversation.matchAll(pattern)]
  return matches.map((match, index) => {
    const label = match[1] ?? ""
    const contentStart = (match.index ?? 0) + match[0].length
    const contentEnd = matches[index + 1]?.index ?? conversation.length
    return {
      kind: segmentKinds[label] ?? "助手",
      content: conversation.slice(contentStart, contentEnd).trim(),
    }
  })
}

function preview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim()
  const characters = Array.from(normalized)
  if (characters.length <= previewLimit) return normalized || "（空）"
  return `${characters.slice(0, previewLimit).join("")}……`
}

function summaryText(conversation: string, segments: Segment[]): string {
  const counts: Record<SegmentKind, number> = {
    用户: 0,
    助手: 0,
    助手思考: 0,
    助手工具调用: 0,
    工具结果: 0,
  }
  for (const segment of segments) counts[segment.kind] += 1
  const first = segments[0]
  const last = segments.at(-1)
  return `## Mock 压缩摘要

- 已压缩 ${segments.length} 段（用户 ${counts.用户}、助手 ${counts.助手}、助手思考 ${counts.助手思考}、助手工具调用 ${counts.助手工具调用}、工具结果 ${counts.工具结果}）
- 压缩原文共 ${Array.from(conversation).length} 个 Unicode 字符
- 首段（${first?.kind ?? "无"}）：“${preview(first?.content ?? "")}”
- 末段（${last?.kind ?? "无"}）：“${preview(last?.content ?? "")}”
- 中间原文已省略；此摘要仅用于验证 Mock 会话的上下文压缩。`
}

/** 为 pi 摘要请求生成长度受控、包含压缩范围诊断信息的 Mock 摘要。 */
export const mockSummaryBehavior: MockBehavior = async function* (context): AsyncIterableIterator<MockEvent> {
  const conversation = extractConversation(lastUserMessage(context.messages))
  yield { type: "text", text: summaryText(conversation, parseSegments(conversation)) }
  yield { type: "finish", reason: "stop" }
}
