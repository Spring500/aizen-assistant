import { SelectRenderable, SelectRenderableEvents, type CliRenderer } from "@opentui/core"
import { editInline, type InlineInputOptions } from "./inline-input.ts"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"
import type { MenuTone } from "./selector.ts"
import { systemColors } from "./theme.ts"

export type EditableField = Omit<InlineInputOptions, "id"> & {
  value: string
  save?: (value: string) => void | Promise<void>
}

export type EditableSelectorItem<T> = {
  id?: string
  name: string
  description: string
  value: T
  disabled?: boolean
  disabledReason?: string
  tone?: MenuTone
  edit?: EditableField
}

export type EditableSelectorOptions = {
  title: string
  signal?: AbortSignal
}

/**
 * 显示支持原地字段编辑的统一菜单；业务层仅提供菜单数据和保存行为。
 */
export function selectEditableItem<T>(
  manager: OverlayManager | CliRenderer,
  id: string,
  getItems: () => EditableSelectorItem<T>[],
  options: EditableSelectorOptions,
): Promise<T | undefined> {
  const overlays = overlayManager(manager)
  return new Promise((resolve) => {
    let settled = false
    let items = getItems()
    const finish = (value: T | undefined, cancelled = false) => {
      if (settled) return
      settled = true
      selector.off(SelectRenderableEvents.SELECTION_CHANGED, updateState)
      handle.close(value)
      resolve(cancelled ? undefined : value)
    }
    const handle = overlays.open<T>({
      id,
      title: options.title,
      description: items[0]?.description ?? "",
      actions: [],
      contentHeight: Math.min(12, Math.max(4, items.length)),
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
      showDescription: false,
      textColor: systemColors.secondary,
      descriptionColor: systemColors.shortcuts,
    })
    handle.content.add(selector)

    const selectedItem = () => items[selector.getSelectedIndex()]
    const updateOptions = (selectedIndex = selector.getSelectedIndex()) => {
      items = getItems()
      selector.options = items
      selector.setSelectedIndex(Math.min(selectedIndex, Math.max(0, items.length - 1)))
      handle.setContentHeight(Math.min(12, Math.max(4, items.length)))
      updateState()
    }
    const startEdit = async (item: EditableSelectorItem<T>, index: number) => {
      if (!item.edit) return
      selector.visible = false
      const result = await editInline(overlays, handle, {
        id: `${id}-field-${item.id ?? index}`,
        label: item.edit.label,
        initialValue: item.edit.value,
        ...(item.edit.placeholder ? { placeholder: item.edit.placeholder } : {}),
        ...(item.edit.mask === undefined ? {} : { mask: item.edit.mask }),
        ...(item.edit.validate ? { validate: item.edit.validate } : {}),
        top: index,
      })
      selector.visible = true
      selector.focus()
      if (result !== undefined) await item.edit.save?.(result)
      updateOptions(index)
    }
    function updateState() {
      const item = selectedItem()
      handle.setDescription(item?.description ?? "")
      handle.setActions([
        {
          id: "move",
          key: { name: "up" },
          alternateKeys: [{ name: "down" }],
          label: "↑↓ 移动",
          run: (key) => {
            selector.handleKeyPress(key)
            updateState()
          },
        },
        {
          id: "select",
          key: { name: "return" },
          label: item?.edit ? "Enter 编辑" : "Enter 选择",
          enabled: !item?.disabled,
          disabledReason: item?.disabledReason ?? item?.description ?? "当前选项不可用",
          run: () => {
            const current = selectedItem()
            if (!current) return
            if (current.edit) void startEdit(current, selector.getSelectedIndex())
            else finish(current.value)
          },
        },
        { id: "cancel", key: { name: "escape" }, label: "Esc 返回", run: () => finish(undefined) },
      ])
    }
    selector.on(SelectRenderableEvents.SELECTION_CHANGED, updateState)
    handle.setInput({
      keypress: (key) => {
        if (key.name === "escape") finish(undefined)
      },
    })
    selector.focus()
    updateState()
  })
}
