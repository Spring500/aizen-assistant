import {
  type CliRenderer,
  CliRenderEvents,
  InputRenderable,
  type KeyEvent,
  type PasteEvent,
  TextRenderable,
} from "@opentui/core"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"
import type { MenuTone } from "./selector.ts"
import { systemColors } from "./theme.ts"

export type EditableField = {
  label: string
  value: string
  placeholder?: string
  mask?: boolean
  validate?: (value: string) => string | undefined
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

type EditingState<T> = {
  item: EditableSelectorItem<T>
  index: number
  input: InputRenderable
  secretValue: string
}

const maximumRows = 12

function itemRows(items: EditableSelectorItem<unknown>[]): number {
  return Math.min(maximumRows, Math.max(4, items.length))
}

function cursor(selected: boolean): string {
  return selected ? "▶ " : "  "
}

/**
 * 显示支持真正行内字段编辑的统一菜单：菜单行和输入框共享滚动、缩进及布局模型。
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
    let selected = 0
    let offset = 0
    let editing: EditingState<T> | undefined
    let items = getItems()
    const handle = overlays.open<T>({
      id,
      title: options.title,
      description: items[0]?.description ?? "",
      actions: [],
      contentHeight: itemRows(items),
      ...(options.signal ? { signal: options.signal } : {}),
      onCancel: () => finish(undefined, true),
    })
    const rows = Array.from(
      { length: maximumRows },
      (_, index) =>
        new TextRenderable(overlays.renderer, {
          id: `${id}-row-${index}`,
          position: "absolute",
          top: index,
          left: 0,
          right: 0,
          height: 1,
          wrapMode: "none",
          truncate: true,
          fg: systemColors.secondary,
          content: "",
        }),
    )
    for (const row of rows) handle.content.add(row)

    function visibleCount(): number {
      const available = Math.max(1, overlays.renderer.terminalHeight - 5)
      return Math.max(1, Math.min(maximumRows, items.length, available))
    }
    function updateOffset() {
      const visible = visibleCount()
      if (selected < offset) offset = selected
      else if (selected >= offset + visible) offset = selected - visible + 1
      offset = Math.max(0, Math.min(offset, Math.max(0, items.length - visible)))
    }
    function render() {
      updateOffset()
      const visible = visibleCount()
      for (const [rowIndex, row] of rows.entries()) {
        const itemIndex = offset + rowIndex
        const item = items[itemIndex]
        row.visible = rowIndex < visible && item !== undefined
        if (!item) continue
        const isSelected = itemIndex === selected
        const isEditing = editing?.index === itemIndex
        row.fg = item.disabled ? systemColors.disabled : isSelected ? systemColors.header : systemColors.secondary
        row.content = `${cursor(isSelected)}${isEditing ? item.edit?.label : item.name}`
      }
      layoutInput()
    }
    function layoutInput() {
      const state = editing
      if (!state || state.input.isDestroyed) return
      const row = state.index - offset
      const visible = visibleCount()
      state.input.visible = row >= 0 && row < visible
      if (!state.input.visible) return
      state.input.top = row
      state.input.left = Bun.stringWidth(`${cursor(true)}${state.item.edit?.label ?? ""}`)
      state.input.right = 0
    }
    function finish(value: T | undefined, cancelled = false) {
      if (settled) return
      settled = true
      overlays.renderer.off(CliRenderEvents.RESIZE, onResize)
      destroyEditing()
      handle.close(value)
      resolve(cancelled ? undefined : value)
    }
    function destroyEditing() {
      editing?.input.destroy()
      editing = undefined
    }
    function updateItems() {
      items = getItems()
      selected = Math.min(selected, Math.max(0, items.length - 1))
      handle.setContentHeight(itemRows(items))
      updateState()
      render()
    }
    function routeEditingKey(key: KeyEvent) {
      const state = editing
      if (!state) return
      if (!state.item.edit?.mask) {
        state.input.handleKeyPress(key)
        return
      }
      const characterOffset = state.input.cursorCharacterOffset ?? state.input.cursorOffset
      if (key.name === "backspace") {
        state.input.handleKeyPress(key)
        if (characterOffset > 0)
          state.secretValue = `${state.secretValue.slice(0, characterOffset - 1)}${state.secretValue.slice(characterOffset)}`
      } else if (key.name === "delete") {
        state.input.handleKeyPress(key)
        state.secretValue = `${state.secretValue.slice(0, characterOffset)}${state.secretValue.slice(characterOffset + 1)}`
      } else if (!key.ctrl && !key.meta && key.sequence.length > 0) {
        const characters = Array.from(key.sequence.replace(/[\r\n]/g, ""))
        if (characters.length === 0) return
        state.secretValue = `${state.secretValue.slice(0, characterOffset)}${characters.join("")}${state.secretValue.slice(characterOffset)}`
        state.input.insertText("•".repeat(characters.length))
      } else state.input.handleKeyPress(key)
    }
    function routeEditingPaste(event: PasteEvent) {
      const state = editing
      if (!state) return
      if (!state.item.edit?.mask) {
        state.input.handlePaste(event)
        return
      }
      const value = new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, "")
      const characterOffset = state.input.cursorCharacterOffset ?? state.input.cursorOffset
      state.secretValue = `${state.secretValue.slice(0, characterOffset)}${value}${state.secretValue.slice(characterOffset)}`
      state.input.insertText("•".repeat(Array.from(value).length))
    }
    function stopEdit(confirm: boolean) {
      const state = editing
      if (!state) return
      const value = state.item.edit?.mask ? state.secretValue : state.input.value
      if (confirm) {
        const error = state.item.edit?.validate?.(value)
        if (error) {
          handle.setError(error)
          return
        }
      }
      destroyEditing()
      if (!confirm) {
        handle.clearError()
        updateState()
        render()
        return
      }
      handle.clearError()
      void Promise.resolve(state.item.edit?.save?.(value)).then(updateItems)
    }
    function startEdit(item: EditableSelectorItem<T>, index: number) {
      if (!item.edit || editing) return
      const input = new InputRenderable(overlays.renderer, {
        id: `${id}-field-${item.id ?? index}-input`,
        position: "absolute",
        top: index - offset,
        left: Bun.stringWidth(`${cursor(true)}${item.edit.label}`),
        right: 0,
        zIndex: 10,
        value: item.edit.mask ? "•".repeat(Array.from(item.edit.value).length) : item.edit.value,
        placeholder: item.edit.placeholder ?? "",
        backgroundColor: "#111827",
        focusedBackgroundColor: "#111827",
        textColor: systemColors.secondary,
        focusedTextColor: systemColors.secondary,
        cursorColor: systemColors.header,
      })
      handle.content.add(input)
      editing = { item, index, input, secretValue: item.edit.value }
      input.cursorOffset = input.value.length
      input.focus()
      updateState()
      render()
    }
    function move(delta: number) {
      selected = Math.max(0, Math.min(items.length - 1, selected + delta))
      updateState()
      render()
    }
    function updateState() {
      const item = editing?.item ?? items[selected]
      handle.setDescription(item?.description ?? "")
      if (editing) {
        handle.setActions([
          { id: "confirm", key: { name: "return" }, label: "Enter 确认", run: () => stopEdit(true) },
          { id: "cancel", key: { name: "escape" }, label: "Esc 取消", run: () => stopEdit(false) },
        ])
        return
      }
      handle.setActions([
        {
          id: "move",
          key: { name: "up" },
          alternateKeys: [{ name: "down" }],
          label: "↑↓ 移动",
          run: (key) => move(key.name === "up" ? -1 : 1),
        },
        {
          id: "select",
          key: { name: "return" },
          label: item?.edit ? "Enter 编辑" : "Enter 选择",
          enabled: !item?.disabled,
          disabledReason: item?.disabledReason ?? item?.description ?? "当前选项不可用",
          run: () => {
            const current = items[selected]
            if (!current) return
            if (current.edit) startEdit(current, selected)
            else finish(current.value)
          },
        },
        { id: "cancel", key: { name: "escape" }, label: "Esc 返回", run: () => finish(undefined) },
      ])
    }
    const onResize = () => {
      render()
    }
    overlays.renderer.on(CliRenderEvents.RESIZE, onResize)
    handle.setInput({
      keypress: (key) => {
        if (editing) routeEditingKey(key)
        else if (key.name === "escape") finish(undefined)
      },
      paste: routeEditingPaste,
    })
    updateState()
    render()
  })
}
