import type { ModelReference } from "../../packages/core/session-format.ts"
import type { ModelOption } from "../../packages/core/pi-port.ts"
import type { RichSelectorItem } from "../../packages/tui-kit/rich-selector.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"
import { modelSettingItem } from "./model-setting-item.ts"

export type PreferenceSettingsAction = "session-naming" | "permission-review" | "apply" | "cancel"

/** 偏好菜单行；allowEmpty 供调用方决定选择菜单是否提供“清除”选项。 */
export type PreferenceSettingsItem = RichSelectorItem<PreferenceSettingsAction> & { allowEmpty?: boolean }

/** 生成应用偏好菜单；当前仅管理会话自动命名与工具审核模型。 */
export function preferenceSettingsItems(
  namingModel: ModelReference | undefined,
  reviewModel: ModelReference | undefined,
  models: ModelOption[],
  providerNames: ReadonlyMap<string, string>,
): PreferenceSettingsItem[] {
  return [
    modelSettingItem({
      model: namingModel,
      models,
      providerNames,
      label: "会话自动命名",
      placeholder: "关闭",
      allowEmpty: true,
      value: "session-naming",
      description: "使用独立模型根据首条用户消息生成会话名称",
    }),
    modelSettingItem({
      model: reviewModel,
      models,
      providerNames,
      label: "工具审核模型",
      placeholder: "未配置",
      allowEmpty: true,
      value: "permission-review",
      description: "AI 权限模式使用的 App 级审核模型",
    }),
    { value: "apply", segments: [{ text: "保存并返回", color: systemColors.statusIdle, bold: true }] },
    { value: "cancel", segments: [{ text: "取消", dim: true }] },
  ]
}
