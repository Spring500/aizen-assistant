import type { ModelOption } from "../../packages/core/pi-port.ts"
import type { ModelReference, ViewId } from "../../packages/core/session-format.ts"
import type { PermissionPresetId, PermissionReviewMode } from "../../packages/core/tool-permissions/policy-types.ts"
import type { ViewOption } from "../../packages/core/view-store.ts"
import type { RichSelectorItem } from "../../packages/tui-kit/rich-selector.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"
import { modelSettingItem } from "./model-setting-item.ts"
import { viewSettingItem } from "./view-setting-item.ts"

export type SessionSettingsDraft = {
  model?: ModelOption
  viewId: ViewId
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

/** 会话设置行；allowEmpty 供调用方决定模型选择菜单是否提供“清除”选项。 */
export type SessionSettingsItem = RichSelectorItem<SessionSettingsAction> & { allowEmpty?: boolean }

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
  models: ModelOption[],
  providerNames: ReadonlyMap<string, string>,
): SessionSettingsItem[] {
  return [
    modelSettingItem({
      model: draft.model,
      models,
      providerNames,
      label: "当前模型",
      placeholder: "未选择模型",
      allowEmpty: false,
      value: "model",
    }),
    viewSettingItem({
      viewId: draft.viewId,
      views,
      label: "当前视图",
      placeholder: "无视图",
      value: "view",
    }),
    {
      value: "permission-preset",
      segments: [
        { text: "权限预设  [ " },
        {
          text: permissionPresetLabels[draft.permissionPreset ?? "edit"],
          color: systemColors.accent,
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
          color: systemColors.accent,
          bold: true,
        },
        { text: " ]" },
      ],
    },
    { value: "manage-models", segments: [{ text: "管理模型", color: systemColors.dim }] },
    { value: "manage-views", segments: [{ text: "管理视图", color: systemColors.dim }] },
    {
      value: "apply",
      segments: [
        {
          text: mode === "new" ? "应用并开始对话" : "应用并退出设置",
          color: systemColors.success,
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
