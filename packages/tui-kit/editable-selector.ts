import {
  type CliRenderer,
  CliRenderEvents,
  createTextAttributes,
  InputRenderable,
  type KeyEvent,
  parseColor,
  type PasteEvent,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"
import type { MenuTone } from "./selector.ts"
import { systemColors } from "./theme.ts"

export type EditableField<T> = {
  label: string
  value: string
  placeholder?: string
  mask?: boolean
  validate?: (value: string) => string | undefined
  /** 草稿变化时通知调用方，用于离开并重建菜单后恢复输入。 */
  draft?: (value: string) => void
  save?: (value: string) => void | Promise<void>
  /** 保存字段后直接提交当前选项；省略时保存后继续停留在菜单。 */
  submit?: (value: string) => T
}

export type EditableSelectorItem<T> = {
  id?: string
  name: string
  description: string
  value: T
  disabled?: boolean
  disabledReason?: string
  tone?: MenuTone
  edit?: EditableField<T>
}

export type EditableHeaderSegment = {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
}

export type EditableSelectorOptions = {
  title: string
  header?: EditableHeaderSegment[]
  headerLines?: string[]
  signal?: AbortSignal
  /** 左右方向键切换同一流程中的相邻页面。 */
  navigate?: (direction: "previous" | "next") => void
}

type EditingState<T> = {
  item: EditableSelectorItem<T>
  index: number
  input: InputRenderable
  secretValue: string
}

type EditableDraft = { value: string; secretValue: string }

const maximumRows = 12

function itemRows(items: EditableSelectorItem<unknown>[]): number {
  return Math.min(maximumRows, Math.max(4, items.length))
}

const toneColors: Record<MenuTone, string> = {
  normal: systemColors.secondary,
  primary: systemColors.header,
  success: systemColors.statusIdle,
  warning: systemColors.statusRunning,
  danger: systemColors.statusError,
  muted: systemColors.disabled,
}

function cursor(selected: boolean): string {
  return selected ? "▶ " : "  "
}

function headerContent(segments: EditableHeaderSegment[]): StyledText {
  return new StyledText(
    segments.map(
      (segment): TextChunk => ({
        __isChunk: true,
        text: segment.text,
        fg: parseColor(segment.color ?? systemColors.secondary),
        attributes: createTextAttributes({
          ...(segment.bold === undefined ? {} : { bold: segment.bold }),
          ...(segment.dim === undefined ? {} : { dim: segment.dim }),
        }),
      }),
    ),
  )
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
    const drafts = new Map<string, EditableDraft>()
    let items = getItems()
    const headerRows = (options.header ? 1 : 0) + (options.headerLines?.length ?? 0)
    const handle = overlays.open<T>({
      id,
      title: options.title,
      description: items[0]?.description ?? "",
      actions: [],
      contentHeight: itemRows(items) + headerRows,
      ...(options.signal ? { signal: options.signal } : {}),
      onCancel: () => finish(undefined, true),
    })
    if (options.header) {
      handle.content.add(
        new TextRenderable(overlays.renderer, {
          id: `${id}-header`,
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 1,
          wrapMode: "none",
          truncate: true,
          content: headerContent(options.header),
        }),
      )
    }
    for (const [index, line] of (options.headerLines ?? []).entries()) {
      handle.content.add(
        new TextRenderable(overlays.renderer, {
          id: `${id}-header-line-${index}`,
          position: "absolute",
          top: (options.header ? 1 : 0) + index,
          left: 0,
          right: 0,
          height: 1,
          wrapMode: "none",
          truncate: true,
          fg: systemColors.secondary,
          content: line,
        }),
      )
    }
    const rows = Array.from(
      { length: maximumRows },
      (_, index) =>
        new TextRenderable(overlays.renderer, {
          id: `${id}-row-${index}`,
          position: "absolute",
          top: index + headerRows,
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
        row.fg = item.disabled
          ? systemColors.disabled
          : isSelected
            ? systemColors.header
            : toneColors[item.tone ?? "normal"]
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
      state.input.top = row + headerRows
      state.input.left = Bun.stringWidth(`${cursor(true)}${state.item.edit?.label ?? ""}`)
      state.input.right = 0
    }
    function draftKey(item: EditableSelectorItem<T>, index: number): string {
      return item.id ?? String(index)
    }
    function captureDraft() {
      const state = editing
      if (!state || state.input.isDestroyed) return
      const value = state.item.edit?.mask ? state.secretValue : state.input.value
      drafts.set(draftKey(state.item, state.index), {
        value: state.input.value,
        secretValue: value,
      })
      state.item.edit?.draft?.(value)
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
      handle.setContentHeight(itemRows(items) + headerRows)
      const item = items[selected]
      if (item?.edit && !item.disabled) startEdit(item, selected)
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
      captureDraft()
      destroyEditing()
      if (!confirm) {
        handle.clearError()
        updateState()
        render()
        return
      }
      handle.clearError()
      void Promise.resolve(state.item.edit?.save?.(value)).then(() => {
        drafts.set(draftKey(state.item, state.index), { value, secretValue: value })
        const submitted = state.item.edit?.submit?.(value)
        if (submitted !== undefined) finish(submitted)
        else updateItems()
      })
    }
    function startEdit(item: EditableSelectorItem<T>, index: number) {
      if (!item.edit) return
      if (editing?.index === index) return
      captureDraft()
      destroyEditing()
      const draft = drafts.get(draftKey(item, index))
      const initialValue = draft?.value ?? item.edit.value
      const secretValue = draft?.secretValue ?? item.edit.value
      const input = new InputRenderable(overlays.renderer, {
        id: `${id}-field-${item.id ?? index}-input`,
        position: "absolute",
        top: index - offset + headerRows,
        left: Bun.stringWidth(`${cursor(true)}${item.edit.label}`),
        right: 0,
        zIndex: 10,
        value: item.edit.mask ? "•".repeat(Array.from(secretValue).length) : initialValue,
        placeholder: item.edit.placeholder ?? "",
        backgroundColor: "#111827",
        focusedBackgroundColor: "#111827",
        textColor: systemColors.secondary,
        focusedTextColor: systemColors.secondary,
        cursorColor: systemColors.header,
      })
      handle.content.add(input)
      editing = { item, index, input, secretValue }
      input.cursorOffset = input.value.length
      input.focus()
      updateState()
      render()
    }
    function move(delta: number) {
      captureDraft()
      selected = Math.max(0, Math.min(items.length - 1, selected + delta))
      const item = items[selected]
      if (item?.edit && !item.disabled) startEdit(item, selected)
      else destroyEditing()
      updateState()
      render()
    }
    function updateState() {
      const item = editing?.item ?? items[selected]
      handle.setDescription(item?.description ?? "")
      if (editing) {
        handle.setActions([
          {
            id: "move",
            key: { name: "up" },
            alternateKeys: [{ name: "down" }],
            label: "↑↓ 移动",
            run: (key) => move(key.name === "up" ? -1 : 1),
          },
          {
            id: "confirm",
            key: { name: "return" },
            label: item?.edit?.submit ? "Enter 提交" : "Enter 保存",
            run: () => stopEdit(true),
          },
          { id: "cancel", key: { name: "escape" }, label: "Esc 返回", run: () => finish(undefined) },
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
          label: item?.edit ? (item.edit.submit ? "Enter 提交" : "Enter 保存") : "Enter 选择",
          enabled: !item?.disabled,
          disabledReason: item?.disabledReason ?? item?.description ?? "当前选项不可用",
          run: () => {
            const current = items[selected]
            if (!current) return
            if (current.edit) stopEdit(true)
            else finish(current.value)
          },
        },
        { id: "cancel", key: { name: "escape" }, label: "Esc 返回", run: () => finish(undefined) },
      ])
    }
    function navigate(direction: "previous" | "next") {
      if (!options.navigate) return
      captureDraft()
      options.navigate(direction)
      finish(undefined, true)
    }
    const onResize = () => {
      render()
    }
    overlays.renderer.on(CliRenderEvents.RESIZE, onResize)
    handle.setInput({
      keypress: (key) => {
        if (options.navigate && !editing && (key.name === "left" || key.name === "right")) {
          navigate(key.name === "left" ? "previous" : "next")
          return
        }
        if (editing) routeEditingKey(key)
        else if (key.name === "escape") finish(undefined)
      },
      paste: routeEditingPaste,
    })
    if (items[0]?.edit && !items[0].disabled) startEdit(items[0], 0)
    updateState()
    render()
  })
}
