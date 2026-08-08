import type { MockBehavior, MockRequestContext } from "../types.ts"

function firstUserText(context: MockRequestContext): string {
  return context.messages.find((message) => message.role === "user")?.content ?? "会话"
}

function timestamp(): string {
  const now = new Date()
  const value = [now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()].map((item) => String(item).padStart(2, "0"))
  return `${value[0]}${value[1]}-${value[2]}${value[3]}`
}

function keyword(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim() || "会话"
  return Array.from(compact).slice(0, 72).join("")
}

/** 为首条用户消息生成符合 set_session_title 契约的单行标题。 */
export const mockNamingBehavior: MockBehavior = async function* (context) {
  const title = `[${timestamp()}] ${keyword(firstUserText(context))}`
  yield { type: "tool", callId: "set_session_title", name: "set_session_title", arguments: { title } }
  yield { type: "finish", reason: "toolUse" }
}
