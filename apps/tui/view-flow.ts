import type { ViewOption } from "../../packages/core/view-store.ts"
import type { SelectorItem } from "../../packages/tui-kit/selector.ts"

export function viewSelectionItems(views: ViewOption[]): SelectorItem<string | null>[] {
  return [
    { name: "无视图", description: "使用内建提示词，不加载 AGENTS.md 和 Skills", value: null },
    ...views
      .filter((item) => item.valid)
      .map((item) => ({ name: item.name, description: `${item.id} · ${item.directory}`, value: item.id })),
  ]
}
