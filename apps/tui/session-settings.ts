import type { ModelOption } from "../../packages/core/pi-port.ts"
import type { ModelReference, ViewId } from "../../packages/core/session-format.ts"
import type { PermissionPresetId, PermissionReviewMode } from "../../packages/core/tool-permissions/policy-types.ts"
import type { PermissionMode } from "../../packages/core/tool-permissions/types.ts"
import type { ViewOption } from "../../packages/core/view-store.ts"
import type { RichSelectorItem } from "../../packages/tui-kit/rich-selector.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"

export type SessionSettingsDraft = {
  model?: ModelOption
  viewId: ViewId
  permissionMode?: PermissionMode
  permissionPreset?: PermissionPresetId
  permissionReviewMode?: PermissionReviewMode
}

export type SessionSettingsAction =
  | "model"
  | "view"
  | "permission-preset"
  | "permission-review-mode"
  | "manage-models"
  | "manage-views"
  | "apply"
  | "cancel"

const permissionPresetLabels: Record<PermissionPresetId, string> = {
  plan: "plan（只读）",
  edit: "edit（编辑）",
  "all-right": "all-right（全放开）",
  custom: "custom（自定义）",
}

const permissionReviewModeLabels: Record<PermissionReviewMode, string> = {
  manual: "完全人工",
  aiReview: "AI 代审",
  aiReviewWithAbstain: "AI 代审（可弃权）",
  autoApprove: "自动放过",
  autoDeny: "自动拒绝",
}

/** 旧偏好中的档位只有在当前模型仍支持时才能覆盖模型的新默认档位。 */
export function modelWithPreferredThinkingLevel(available: ModelOption, preferred: ModelReference): ModelOption {
  const levels = [
    ...(available.offThinkingLevel === undefined ? [] : [available.offThinkingLevel]),
    ...(available.thinkingLevels ?? []),
  ]
  return {
    ...available,
    ...(preferred.thinkingLevel !== undefined && levels.includes(preferred.thinkingLevel)
      ? { thinkingLevel: preferred.thinkingLevel }
      : {}),
  }
}

export function sessionSettingsItems(
  draft: SessionSettingsDraft,
  views: ViewOption[],
  mode: "new" | "existing",
): RichSelectorItem<SessionSettingsAction>[] {
  const view = draft.viewId === null ? undefined : views.find((item) => item.id === draft.viewId)
  return [
    {
      value: "model",
      segments: [
        { text: "当前模型  [ " },
        { text: draft.model?.providerId ?? "none", italic: true, dim: true },
        { text: " · " },
        { text: draft.model?.name ?? "未选择模型", color: systemColors.sessionStatus, bold: true },
        { text: " ]" },
      ],
    },
    {
      value: "view",
      segments: [
        { text: "当前视图  [ " },
        { text: view?.id ?? "none", italic: true, dim: true },
        { text: " · " },
        { text: view?.name ?? "无视图", color: systemColors.sessionStatus, bold: true },
        { text: " ]" },
      ],
    },
    {
      value: "permission-preset",
      segments: [
        { text: "权限预设  [ " },
        {
          text: permissionPresetLabels[draft.permissionPreset ?? "edit"],
          color: systemColors.sessionStatus,
          bold: true,
        },
        { text: " ]" },
      ],
    },
    {
      value: "permission-review-mode",
      segments: [
        { text: "审核方式  [ " },
        {
          text: permissionReviewModeLabels[draft.permissionReviewMode ?? "manual"],
          color: systemColors.sessionStatus,
          bold: true,
        },
        { text: " ]" },
      ],
    },
    { value: "manage-models", segments: [{ text: "管理模型", color: systemColors.secondary }] },
    { value: "manage-views", segments: [{ text: "管理视图", color: systemColors.secondary }] },
    {
      value: "apply",
      segments: [
        {
          text: mode === "new" ? "应用并开始对话" : "应用并退出设置",
          color: systemColors.statusIdle,
          bold: true,
        },
      ],
    },
    {
      value: "cancel",
      segments: [{ text: mode === "new" ? "取消并返回会话列表" : "取消并退出设置", dim: true }],
    },
  ]
}
