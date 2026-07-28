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
      help: "Space 切换 | Enter 保存 | Esc 取消",
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
      fg: systemColors.secondary,
      content: "",
    })
    handle.content.add(view)
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
    }
    const finish = (value: T[] | undefined, cancelled = false) => {
      if (settled) return
      settled = true
      handle.close(value)
      resolve(cancelled ? undefined : value)
    }
    handle.setInput({
      keypress: (key) => {
        const space = key.name === "space" || key.sequence === " "
        if (key.name === "escape") finish(undefined)
        else if (key.name === "return") finish([...selected])
        else if (key.name === "up") {
          index = (index - 1 + items.length) % items.length
          render()
        } else if (key.name === "down") {
          index = (index + 1) % items.length
          render()
        } else if (space) {
          const item = items[index]
          if (item && !item.disabled) {
            if (selected.has(item.value)) selected.delete(item.value)
            else selected.add(item.value)
            render()
          }
        }
      },
    })
    render()
  })
}
