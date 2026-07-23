import { type CliRenderer, type KeyEvent, SelectRenderable, SelectRenderableEvents } from "@opentui/core"

export type SelectorItem<T> = { name: string; description: string; value: T }

export function selectItem<T>(renderer: CliRenderer, id: string, items: SelectorItem<T>[]): Promise<T | undefined> {
  return new Promise((resolve) => {
    const selector = new SelectRenderable(renderer, {
      id,
      options: items,
      position: "absolute",
      top: 1,
      right: 0,
      bottom: 4,
      left: 0,
      zIndex: 100,
      showDescription: true,
    })
    renderer.root.add(selector)
    selector.focus()
    const finish = (value: T | undefined) => {
      renderer.keyInput.off("keypress", onKeyPress)
      selector.destroy()
      resolve(value)
    }
    const onKeyPress = (key: KeyEvent) => {
      if (key.name === "escape") finish(undefined)
    }
    renderer.keyInput.on("keypress", onKeyPress)
    selector.once(SelectRenderableEvents.ITEM_SELECTED, () =>
      finish(selector.getSelectedOption()?.value as T | undefined),
    )
  })
}
