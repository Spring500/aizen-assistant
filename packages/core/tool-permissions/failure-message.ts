import type { PermissionReviewStep, ToolAuthorization } from "./types.ts"
import { sanitizeReviewPayload } from "./sanitizer.ts"

const stageLabels: Record<PermissionReviewStep["stage"], string> = {
  validator: "Validator",
  ai: "AI reviewer",
  human: "User",
  system: "System",
}

/** 将已经实际发生的审核环节附加到工具结果，供 Agent 理解失败或中断原因。 */
export function appendPermissionReview(message: string, steps: PermissionReviewStep[] | undefined): string {
  if (!steps || steps.length === 0) return message
  const safeSteps = sanitizeReviewPayload(steps) as unknown as PermissionReviewStep[]
  const lines = safeSteps.flatMap((step, index) => [
    `${index + 1}. ${stageLabels[step.stage]}: ${step.decision}`,
    `   Reason: ${step.reason}`,
  ])
  return `${message}\n\nPermission review:\n${lines.join("\n")}`
}

/** 仅为未获准的工具调用附加各审核环节已经产生的原因。 */
export function permissionFailureMessage(authorization: Exclude<ToolAuthorization, { type: "allow" }>): string {
  return appendPermissionReview(authorization.reason, authorization.reviewSteps)
}
