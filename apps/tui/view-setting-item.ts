import type { ViewOption } from "../../packages/core/view-store.ts"
import type { RichSelectorItem } from "../../packages/tui-kit/rich-selector.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"

export type ViewSettingItemOptions = {
  /** 当前视图 id；null 表示无视图。 */
  viewId: string | null
  /** 视图列表，用于把 viewId 解析为视图名。 */
  views?: ViewOption[]
  /** 行首标签，如"当前视图"。 */
  label: string
  /** 未选择或视图失效时的占位文案（如"无视图"）。 */
  placeholder: string
  /** 该行被选中时返回的动作标识。 */
  value: string
  /** 底部说明文字；省略时不显示详情行。 */
  description?: string
}

/**
 * 视图设置行的统一样式：未选择或视图失效时显示占位文案；
 * 已选择时只显示 [ 视图名 ]（不再展示 viewId），视图名高亮加粗。
 */
export function viewSettingItem<T extends string>(options: ViewSettingItemOptions & { value: T }): RichSelectorItem<T> {
  const view = options.viewId === null ? undefined : options.views?.find((item) => item.id === options.viewId)
  return {
    value: options.value,
    segments: view
      ? [{ text: `${options.label}  [ ` }, { text: view.name, color: systemColors.accent, bold: true }, { text: " ]" }]
      : [{ text: `${options.label}  [ ` }, { text: options.placeholder, color: systemColors.dim }, { text: " ]" }],
    ...(options.description ? { details: [{ text: options.description, dim: true }] } : {}),
  }
}
