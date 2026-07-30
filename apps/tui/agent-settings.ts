import type { AgentModelReference } from "../../packages/core/app-preferences-store.ts"
import type { ModelOption } from "../../packages/core/pi-port.ts"
import type { RichSelectorItem } from "../../packages/tui-kit/rich-selector.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"

export type AgentSettingsAction = "session-naming" | "apply" | "cancel"

/** 生成内置 Agent 设置菜单；当前仅管理会话自动命名模型。 */
export function agentSettingsItems(
  model: AgentModelReference | undefined,
  models: ModelOption[],
): RichSelectorItem<AgentSettingsAction>[] {
  const selected = model
    ? models.find((item) => item.providerId === model.providerId && item.modelId === model.modelId)
    : undefined
  return [
    {
      value: "session-naming",
      segments: [
        { text: "会话自动命名  [ " },
        {
          text: model ? (selected?.name ?? `${model.providerId}/${model.modelId}`) : "关闭",
          color: model ? systemColors.sessionStatus : systemColors.shortcuts,
          bold: !!model,
        },
        { text: " ]" },
      ],
      details: [{ text: "使用独立模型根据首条用户消息生成会话名称", dim: true }],
    },
    { value: "apply", segments: [{ text: "保存并返回", color: systemColors.statusIdle, bold: true }] },
    { value: "cancel", segments: [{ text: "取消", dim: true }] },
  ]
}
