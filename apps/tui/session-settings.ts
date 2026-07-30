import type { ModelOption } from "../../packages/core/pi-port.ts"
import type { ViewId } from "../../packages/core/session-format.ts"
import type { PermissionMode } from "../../packages/core/tool-permissions/types.ts"
import type { ViewOption } from "../../packages/core/view-store.ts"
import type { RichSelectorItem } from "../../packages/tui-kit/rich-selector.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"

export type SessionSettingsDraft = {
  model?: ModelOption
  viewId: ViewId
  permissionMode?: PermissionMode
}

export type SessionSettingsAction =
  | "model"
  | "view"
  | "permission-mode"
  | "manage-models"
  | "manage-views"
  | "apply"
  | "cancel"

const permissionModeLabels: Record<PermissionMode, string> = {
  unrestricted: "完全开放",
  hybrid: "自动审核 + 人工审核",
  hybridConfirmDenials: "自动审核 + 人工确认拒绝",
  aiOnly: "仅自动审核",
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
      value: "permission-mode",
      segments: [
        { text: "权限模式  [ " },
        { text: permissionModeLabels[draft.permissionMode ?? "hybrid"], color: systemColors.sessionStatus, bold: true },
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
