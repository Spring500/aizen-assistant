import { type CliRenderer, type KeyEvent, TextRenderable } from "@opentui/core"
import { systemColors } from "./theme.ts"

export type MultiChoiceItem<T extends string> = {
  value: T
  label: string
  selected: boolean
  disabled?: boolean
  disabledReason?: string
}

export function selectMultiple<T extends string>(
  renderer: CliRenderer,
  id: string,
  titleText: string,
  items: MultiChoiceItem<T>[],
  signal?: AbortSignal,
): Promise<T[] | undefined> {
  return new Promise((resolve) => {
    const selected = new Set(items.filter((item) => item.selected).map((item) => item.value))
    let index = 0
    let settled = false
    const view = new TextRenderable(renderer, {
      id,
      position: "absolute",
      top: 1,
      right: 0,
      bottom: 3,
      left: 0,
      zIndex: 120,
      fg: systemColors.secondary,
      content: "",
    })
    const render = () => {
      view.content = [
        titleText,
        "",
        ...items.map((item, itemIndex) => {
          const cursor = itemIndex === index ? ">" : " "
          const mark = item.disabled ? "-" : selected.has(item.value) ? "x" : " "
          const reason = item.disabledReason ? `  ${item.disabledReason}` : ""
          return `${cursor} [${mark}] ${item.label}${reason}`
        }),
        "",
        "Space 切换 | Enter 保存 | Esc 取消",
      ].join("\n")
    }
    const finish = (value: T[] | undefined) => {
      if (settled) return
      settled = true
      renderer.keyInput.off("keypress", onKeyPress)
      signal?.removeEventListener("abort", onAbort)
      view.destroy()
      resolve(value)
    }
    const onKeyPress = (key: KeyEvent) => {
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
    }
    const onAbort = () => finish(undefined)
    renderer.root.add(view)
    renderer.keyInput.on("keypress", onKeyPress)
    if (signal?.aborted) finish(undefined)
    else signal?.addEventListener("abort", onAbort, { once: true })
    render()
  })
}
