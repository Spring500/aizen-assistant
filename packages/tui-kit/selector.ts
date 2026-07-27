import {
  type CliRenderer,
  type KeyEvent,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
} from "@opentui/core"
import { systemColors } from "./theme.ts"

export type SelectorItem<T> = { name: string; description: string; value: T }
export type SelectorOptions = { title: string; signal?: AbortSignal }

export function selectItem<T>(
  renderer: CliRenderer,
  id: string,
  items: SelectorItem<T>[],
  options: SelectorOptions,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const previousFooterHeight = renderer.footerHeight
    if (renderer.screenMode === "split-footer") {
      renderer.footerHeight = Math.max(previousFooterHeight, Math.min(20, Math.max(8, renderer.terminalHeight - 2)))
    }
    const title = new TextRenderable(renderer, {
      id: `${id}-title`,
      height: 1,
      position: "absolute",
      top: 1,
      right: 0,
      left: 0,
      zIndex: 101,
      fg: systemColors.secondary,
      content: options.title,
    })
    const selector = new SelectRenderable(renderer, {
      id,
      options: items,
      position: "absolute",
      top: 2,
      right: 0,
      bottom: 4,
      left: 0,
      zIndex: 100,
      showDescription: true,
      textColor: systemColors.secondary,
      descriptionColor: systemColors.shortcuts,
    })
    renderer.root.add(title)
    renderer.root.add(selector)
    selector.focus()
    let settled = false
    const finish = (value: T | undefined) => {
      if (settled) return
      settled = true
      renderer.keyInput.off("keypress", onKeyPress)
      options.signal?.removeEventListener("abort", onAbort)
      selector.destroy()
      title.destroy()
      renderer.footerHeight = previousFooterHeight
      resolve(value)
    }
    const onKeyPress = (key: KeyEvent) => {
      if (key.name === "escape") finish(undefined)
    }
    const onAbort = () => finish(undefined)
    renderer.keyInput.on("keypress", onKeyPress)
    selector.once(SelectRenderableEvents.ITEM_SELECTED, () =>
      finish(selector.getSelectedOption()?.value as T | undefined),
    )
    if (options.signal?.aborted) finish(undefined)
    else options.signal?.addEventListener("abort", onAbort, { once: true })
  })
}
