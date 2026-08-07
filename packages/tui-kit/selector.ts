import { SelectRenderable, SelectRenderableEvents } from "@opentui/core"
import type { CliRenderer } from "@opentui/core"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"
import { systemColors } from "./theme.ts"

export type MenuTone = "normal" | "primary" | "success" | "warning" | "danger" | "muted"

export type SelectorItem<T> = {
  id?: string
  name: string
  description: string
  value: T
  disabled?: boolean
  disabledReason?: string
  tone?: MenuTone
}
export type SelectorOptions = { title: string; signal?: AbortSignal; initialIndex?: number }

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
      description: items[options.initialIndex ?? 0]?.description ?? "",
      actions: [],
      contentHeight: Math.min(12, Math.max(4, items.length)),
      ...(options.signal ? { signal: options.signal } : {}),
      onCancel: () => finish(undefined, true),
    })
    const selector = new SelectRenderable(overlays.renderer, {
      id,
      options: items,
      selectedIndex: options.initialIndex ?? 0,
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      showDescription: false,
      textColor: systemColors.secondary,
      descriptionColor: systemColors.shortcuts,
    })
    const selectedItem = () => items[selector.getSelectedIndex()]
    const updateState = () => {
      const item = selectedItem()
      handle.setDescription(item?.description ?? "")
      handle.setActions([
        {
          id: "move",
          key: { name: "up" },
          alternateKeys: [{ name: "down" }],
          label: "↑↓ 移动",
          run: (key) => {
            selector.handleKeyPress?.(key)
            updateState()
          },
        },
        {
          id: "select",
          key: { name: "return" },
          label: "Enter 选择",
          enabled: !item?.disabled,
          disabledReason: item?.disabledReason ?? item?.description ?? "当前选项不可用",
          run: () => finish(item?.value),
        },
        { id: "cancel", key: { name: "escape" }, label: "Esc 返回", run: () => finish(undefined) },
      ])
    }
    const onSelected = () => {
      const item = selectedItem()
      if (!item?.disabled) finish(item?.value)
      else updateState()
    }
    selector.on(SelectRenderableEvents.ITEM_SELECTED, onSelected)
    selector.on(SelectRenderableEvents.SELECTION_CHANGED, updateState)
    handle.content.add(selector)
    handle.setInput({
      keypress: (key) => {
        if (key.name === "escape") finish(undefined)
        else {
          selector.handleKeyPress?.(key)
          updateState()
        }
      },
    })
    updateState()
  })
}
