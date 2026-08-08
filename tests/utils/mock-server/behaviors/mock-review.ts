import type { MockBehavior, MockRequestContext } from "../types.ts"

function declaredIntent(context: MockRequestContext): string {
  const source = context.messages.find((message) => message.role === "user")?.content ?? ""
  try {
    const parsed = JSON.parse(source) as { declaredIntent?: unknown }
    return typeof parsed.declaredIntent === "string" ? parsed.declaredIntent : ""
  } catch {
    return ""
  }
}

/** 根据审核请求 declaredIntent 中的暗语返回确定的权限裁决。 */
export const mockReviewBehavior: MockBehavior = async function* (context) {
  const intent = declaredIntent(context)
  const decision = intent.includes("[通过]") ? "allow" : intent.includes("[拒绝]") ? "deny" : "needHumanReview"
  const reason =
    decision === "allow"
      ? "意图包含放行暗语。"
      : decision === "deny"
        ? "意图包含拒绝暗语。"
        : "意图未包含可自动裁决的暗语。"
  yield { type: "tool", callId: "submit_permission_review", name: "submit_permission_review", arguments: { decision, reason } }
  yield { type: "finish", reason: "toolUse" }
}
