import type { ModelOption } from "../../packages/core/pi-port.ts"
import type { ModelReference } from "../../packages/core/session-format.ts"
import type { RichSelectorItem } from "../../packages/tui-kit/rich-selector.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"

/**
 * 解析模型显示名：引用若自带 name（如 ModelOption）优先使用，
 * 否则从 models 列表按 providerId/modelId 查表；都无匹配时回退 modelId。
 * 显示名属于定义层信息，引用层不持久化 name。
 */
function modelName(model: ModelReference, models?: ModelOption[]): string | undefined {
  if ("name" in model && typeof (model as { name?: unknown }).name === "string") return (model as ModelOption).name
  return models?.find((item) => item.providerId === model.providerId && item.modelId === model.modelId)?.name
}

export type ModelSettingItemOptions = {
  /** 当前已选择的模型引用；省略或传 undefined 表示未选择。 */
  model?: ModelReference | undefined
  /** 可用模型列表，用于把 modelId 解析为模型显示名。 */
  models?: ModelOption[]
  /** providerId → 供应商显示名；缺失时回退 providerId。 */
  providerNames?: ReadonlyMap<string, string>
  /** 行首标签，如"会话自动命名"、"工具审核模型"、"当前模型"。 */
  label: string
  /** 未选择时的占位文案，保留各页语义（如"关闭"、"未配置"、"未选择模型"）。 */
  placeholder: string
  /** 该行被选中时返回的动作标识。 */
  value: string
  /** 底部说明文字；省略时不显示详情行。 */
  description?: string
  /** 是否允许选择空模型；true 时选择菜单提供"清除当前选择模型"选项。 */
  allowEmpty: boolean
}

/**
 * 模型设置行的统一样式：未选择时显示占位文案；
 * 已选择时显示 [ 供应商显示名 · 模型显示名 ]，存在思考等级时追加“· 思考等级名”；
 * 供应商名斜体弱化、模型名与思考等级名高亮加粗。
 */
export type ModelSettingItem<T extends string> = RichSelectorItem<T> & {
  allowEmpty: boolean
}

export function modelSettingItem<T extends string>(
  options: ModelSettingItemOptions & { value: T },
): ModelSettingItem<T> {
  const { model } = options
  const resolvedName = model ? modelName(model, options.models) : undefined
  const providerName = model ? (options.providerNames?.get(model.providerId) ?? model.providerId) : undefined
  return {
    value: options.value,
    allowEmpty: options.allowEmpty,
    segments: model
      ? [
          { text: `${options.label}  [ ` },
          { text: providerName ?? "", italic: true, dim: true },
          { text: " · " },
          { text: resolvedName ?? model.modelId, color: systemColors.accent, bold: true },
          ...(model.thinkingLevel
            ? [{ text: " · " }, { text: model.thinkingLevel, color: systemColors.accent, bold: true }]
            : []),
          { text: " ]" },
        ]
      : [{ text: `${options.label}  [ ` }, { text: options.placeholder, color: systemColors.dim }, { text: " ]" }],
    ...(options.description ? { details: [{ text: options.description, dim: true }] } : {}),
  }
}

/**
 * 生成纯文本的模型显示：供应商名 · 模型名，存在思考等级时追加“· 思考等级名”；
 * 无模型时返回占位文案。供状态栏等纯文本场景与设置行共用同一套解析与格式。
 */
export function modelDisplayText(
  model: ModelReference | undefined,
  models: ModelOption[],
  providerNames: ReadonlyMap<string, string>,
  placeholder = "未选择模型",
): string {
  if (!model) return placeholder
  const resolvedName = modelName(model, models) ?? model.modelId
  const providerName = providerNames.get(model.providerId) ?? model.providerId
  return model.thinkingLevel
    ? `${providerName} · ${resolvedName} · ${model.thinkingLevel}`
    : `${providerName} · ${resolvedName}`
}
