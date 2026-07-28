import { SelectRenderable, SelectRenderableEvents } from "@opentui/core"
import type { CliRenderer } from "@opentui/core"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"
import { systemColors } from "./theme.ts"

export type SelectorItem<T> = { name: string; description: string; value: T; disabled?: boolean }
export type SelectorOptions = { title: string; signal?: AbortSignal }

export function selectItem<T>(
  manager: OverlayManager | CliRenderer,
  id: string,
  items: SelectorItem<T>[],
  options: SelectorOptions,
): Promise<T | undefined> {
  const overlays = overlayManager(manager)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T | undefined, cancelled = false) => {
      if (settled) return
      settled = true
      selector.off(SelectRenderableEvents.ITEM_SELECTED, onSelected)
      handle.close(value)
      resolve(cancelled ? undefined : value)
    }
    const handle = overlays.open<T>({
      id,
      title: options.title,
      help: "↑↓ 移动 | Enter 选择 | Esc 返回",
      contentHeight: Math.min(18, Math.max(6, items.length * 3 - 2)),
      ...(options.signal ? { signal: options.signal } : {}),
      onCancel: () => finish(undefined, true),
    })
    const selector = new SelectRenderable(overlays.renderer, {
      id,
      options: items,
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      showDescription: true,
      textColor: systemColors.secondary,
      descriptionColor: systemColors.shortcuts,
    })
    const onSelected = () => {
      const selected = selector.getSelectedOption()
      const item = items.find((candidate) => candidate.value === selected?.value)
      if (!item?.disabled) finish(selected?.value as T | undefined)
    }
    selector.on(SelectRenderableEvents.ITEM_SELECTED, onSelected)
    handle.content.add(selector)
    handle.setInput({
      keypress: (key) => {
        if (key.name === "escape") finish(undefined)
        else selector.handleKeyPress?.(key)
      },
    })
  })
}
