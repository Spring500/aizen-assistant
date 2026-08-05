import type { ViewOption } from "../../packages/core/view-store.ts"
import type { SelectorItem } from "../../packages/tui-kit/selector.ts"

export function viewSelectionItems(views: ViewOption[]): SelectorItem<string | null>[] {
  return [
    {
      name: "无视图",
      description: "原生模式：内建提示词 + 个人技能 + 项目上下文",
      value: null,
    },
    ...views
      .filter((item) => item.valid)
      .map((item) => ({ name: item.name, description: `${item.id} · ${item.directory}`, value: item.id })),
  ]
}
