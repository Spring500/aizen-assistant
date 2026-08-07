import type { AgentModelReference } from "../../packages/core/app-preferences-store.ts"
import type { ModelOption } from "../../packages/core/pi-port.ts"
import type { RichSelectorItem } from "../../packages/tui-kit/rich-selector.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"

export type PreferenceSettingsAction = "session-naming" | "permission-review" | "apply" | "cancel"

/** 生成应用偏好菜单；当前仅管理会话自动命名与工具审核模型。 */
export function preferenceSettingsItems(
  namingModel: AgentModelReference | undefined,
  reviewModelOrModels: AgentModelReference | ModelOption[] | undefined,
  optionalModels?: ModelOption[],
): RichSelectorItem<PreferenceSettingsAction>[] {
  const reviewModel = Array.isArray(reviewModelOrModels) ? undefined : reviewModelOrModels
  const models = Array.isArray(reviewModelOrModels) ? reviewModelOrModels : (optionalModels ?? [])
  const namingSelected = namingModel
    ? models.find((item) => item.providerId === namingModel.providerId && item.modelId === namingModel.modelId)
    : undefined
  const reviewSelected = reviewModel
    ? models.find((item) => item.providerId === reviewModel.providerId && item.modelId === reviewModel.modelId)
    : undefined
  return [
    {
      value: "session-naming",
      segments: [
        { text: "会话自动命名  [ " },
        {
          text: namingModel ? (namingSelected?.name ?? `${namingModel.providerId}/${namingModel.modelId}`) : "关闭",
          color: namingModel ? systemColors.sessionStatus : systemColors.shortcuts,
          bold: !!namingModel,
        },
        { text: " ]" },
      ],
      details: [{ text: "使用独立模型根据首条用户消息生成会话名称", dim: true }],
    },
    {
      value: "permission-review",
      segments: [
        { text: "工具审核模型  [ " },
        {
          text: reviewModel ? (reviewSelected?.name ?? `${reviewModel.providerId}/${reviewModel.modelId}`) : "未配置",
          color: reviewModel ? systemColors.sessionStatus : systemColors.shortcuts,
          bold: !!reviewModel,
        },
        { text: " ]" },
      ],
      details: [{ text: "AI 权限模式使用的 App 级审核模型", dim: true }],
    },
    { value: "apply", segments: [{ text: "保存并返回", color: systemColors.statusIdle, bold: true }] },
    { value: "cancel", segments: [{ text: "取消", dim: true }] },
  ]
}
