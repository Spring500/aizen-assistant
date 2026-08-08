import type { PermissionDisposition, PermissionReviewMode } from "./policy-types.ts"

export type PermissionReviewRoute = "allow" | "deny" | "human" | "ai" | "aiWithAbstain"

/** 将策略处置与审核方式组合为最终执行、拒绝或审核路由。 */
export function resolvePermissionDisposition(
  disposition: PermissionDisposition,
  reviewMode: PermissionReviewMode,
): PermissionReviewRoute {
  if (disposition === "allow" || disposition === "deny") return disposition
  if (reviewMode === "autoApprove") return "allow"
  if (reviewMode === "autoDeny") return "deny"
  if (disposition === "needHumanReview" || reviewMode === "manual") return "human"
  return reviewMode === "aiReviewWithAbstain" ? "aiWithAbstain" : "ai"
}
