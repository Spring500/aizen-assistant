import type { PermissionReviewStep, ToolAuthorization } from "../core/tool-permissions/types.ts"
import { sanitizeReviewPayload } from "../core/tool-permissions/sanitizer.ts"

const stageLabels: Record<PermissionReviewStep["stage"], string> = {
  validator: "Validator",
  ai: "AI reviewer",
  human: "User",
  system: "System",
}

/** 仅为未获准的工具调用附加各审核环节已经产生的原因。 */
export function permissionFailureMessage(authorization: Exclude<ToolAuthorization, { type: "allow" }>): string {
  const steps = authorization.reviewSteps ?? []
  if (steps.length === 0) return authorization.reason
  const safeSteps = sanitizeReviewPayload(steps) as unknown as PermissionReviewStep[]
  const lines = safeSteps.flatMap((step, index) => [
    `${index + 1}. ${stageLabels[step.stage]}: ${step.decision}`,
    `   Reason: ${step.reason}`,
  ])
  return `${authorization.reason}\n\nPermission review:\n${lines.join("\n")}`
}
