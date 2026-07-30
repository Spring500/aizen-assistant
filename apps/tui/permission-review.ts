import type { HumanReviewRequest } from "../../packages/core/tool-permissions/types.ts"
import type { OverlayManager } from "../../packages/tui-kit/overlay-manager.ts"
import {
  createPermissionReviewView,
  type PermissionReviewController,
} from "../../packages/tui-kit/permission-review-view.ts"

export type { PermissionReviewController }

/** 使用 TUI 适配层打开工具权限审核页。 */
export function createPermissionReview(
  overlays: OverlayManager,
  requests: HumanReviewRequest[],
  answer: (requestId: string, decision: "approve" | "deny") => void,
  signal?: AbortSignal,
): PermissionReviewController {
  return createPermissionReviewView(overlays, requests, answer, signal)
}
