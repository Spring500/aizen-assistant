import { type CliRenderer, TextRenderable } from "@opentui/core"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"
import { systemColors } from "./theme.ts"

export type MultiChoiceItem<T extends string> = {
  value: T
  label: string
  selected: boolean
  disabled?: boolean
  disabledReason?: string
}

export function selectMultiple<T extends string>(
  manager: OverlayManager | CliRenderer,
  id: string,
  titleText: string,
  items: MultiChoiceItem<T>[],
  signal?: AbortSignal,
): Promise<T[] | undefined> {
  const overlays = overlayManager(manager)
  return new Promise((resolve) => {
    const selected = new Set(items.filter((item) => item.selected).map((item) => item.value))
    let index = 0
    let settled = false
    const visibleRows = Math.max(1, Math.min(items.length, 12))
    const handle = overlays.open<T[]>({
      id,
      title: titleText,
      description: items[0]?.disabledReason ?? "",
      actions: [],
      contentHeight: visibleRows,
      ...(signal ? { signal } : {}),
      onCancel: () => finish(undefined, true),
    })
    const view = new TextRenderable(overlays.renderer, {
      id,
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      wrapMode: "none",
      truncate: true,
      fg: systemColors.dim,
      content: "",
    })
    handle.content.add(view)
    const updateState = () => {
      const item = items[index]
      handle.setDescription(item?.disabledReason ?? "")
      handle.setActions([
        {
          id: "move",
          key: { name: "up" },
          alternateKeys: [{ name: "down" }],
          label: "↑↓ 移动",
          run: (key) => {
            index = key.name === "up" ? (index - 1 + items.length) % items.length : (index + 1) % items.length
            render()
          },
        },
        {
          id: "toggle",
          key: { name: "space" },
          label: "Space 切换",
          enabled: !item?.disabled,
          disabledReason: item?.disabledReason ?? "当前选项不可用",
          run: () => {
            if (!item) return
            if (selected.has(item.value)) selected.delete(item.value)
            else selected.add(item.value)
            render()
          },
        },
        { id: "save", key: { name: "return" }, label: "Enter 保存", run: () => finish([...selected]) },
        { id: "cancel", key: { name: "escape" }, label: "Esc 取消", run: () => finish(undefined) },
      ])
    }
    const render = () => {
      const maxOffset = Math.max(0, items.length - visibleRows)
      const offset = Math.min(maxOffset, Math.max(0, index - visibleRows + 1))
      view.content = items
        .slice(offset, offset + visibleRows)
        .map((item, row) => {
          const cursor = offset + row === index ? ">" : " "
          const mark = item.disabled ? "-" : selected.has(item.value) ? "x" : " "
          const reason = item.disabledReason ? `  ${item.disabledReason}` : ""
          return `${cursor} [${mark}] ${item.label}${reason}`
        })
        .join("\n")
      updateState()
    }
    const finish = (value: T[] | undefined, cancelled = false) => {
      if (settled) return
      settled = true
      handle.close(value)
      resolve(cancelled ? undefined : value)
    }
    handle.setInput({
      keypress: (key) => {
        if (key.name === "escape") finish(undefined)
      },
    })
    render()
  })
}
