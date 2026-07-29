import { type CliRenderer, InputRenderable, TextRenderable } from "@opentui/core"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"
import { systemColors } from "./theme.ts"

export type PromptOptions = {
  mask?: boolean
  signal?: AbortSignal
  onCancel?: () => void
  initialValue?: string
}

/**
 * 显示基于 OpenTUI 原生单行输入控件的独立输入页。
 * 普通业务字段应优先使用行内编辑；该入口保留给认证等独立流程。
 */
export function promptLine(
  manager: OverlayManager | CliRenderer,
  id: string,
  label: string,
  options: PromptOptions = {},
): Promise<string | undefined> {
  const overlays = overlayManager(manager)
  return new Promise((resolve) => {
    let settled = false
    const labelWidth = Math.max(1, Bun.stringWidth(label))
    const handle = overlays.open<string>({
      id,
      title: "",
      actions: [],
      contentHeight: 1,
      ...(options.signal ? { signal: options.signal } : {}),
      onCancel: () => finish(true),
    })
    const labelView = new TextRenderable(overlays.renderer, {
      id: `${id}-label`,
      position: "absolute",
      top: 0,
      left: 0,
      width: labelWidth,
      height: 1,
      wrapMode: "none",
      truncate: true,
      fg: systemColors.secondary,
      content: label,
    })
    let maskView: TextRenderable | undefined
    let secretValue = options.initialValue ?? ""
    const input = new InputRenderable(overlays.renderer, {
      id: `${id}-input`,
      position: "absolute",
      top: 0,
      left: labelWidth,
      right: 0,
      value: options.mask ? "•".repeat(Array.from(secretValue).length) : secretValue,
      backgroundColor: "#111827",
      focusedBackgroundColor: "#111827",
      textColor: systemColors.secondary,
      focusedTextColor: systemColors.secondary,
      cursorColor: systemColors.header,
      onContentChange: () => queueMicrotask(renderMask),
    })
    if (options.mask) {
      maskView = new TextRenderable(overlays.renderer, {
        id: `${id}-mask`,
        position: "absolute",
        top: 0,
        left: labelWidth,
        right: 0,
        height: 1,
        wrapMode: "none",
        truncate: true,
        fg: systemColors.secondary,
        bg: "#111827",
        zIndex: 1,
        content: "",
      })
    }
    handle.content.add(labelView)
    handle.content.add(input)
    if (maskView) handle.content.add(maskView)

    function renderMask() {
      if (maskView && !maskView.isDestroyed) maskView.content = input.value
    }
    function finish(cancelled: boolean) {
      if (settled) return
      settled = true
      const value = input.isDestroyed ? undefined : options.mask ? secretValue : input.value
      handle.close(cancelled ? undefined : value)
      if (cancelled) options.onCancel?.()
      resolve(cancelled ? undefined : value)
    }
    handle.setActions([
      { id: "confirm", key: { name: "return" }, label: "Enter 确认", run: () => finish(false) },
      { id: "cancel", key: { name: "escape" }, label: "Esc 取消", run: () => finish(true) },
    ])
    handle.setInput({
      keypress: (key) => {
        if (!options.mask) {
          input.handleKeyPress(key)
          return
        }
        const offset = input.cursorOffset
        if (key.name === "backspace") {
          input.handleKeyPress(key)
          if (offset > 0) secretValue = `${secretValue.slice(0, offset - 1)}${secretValue.slice(offset)}`
        } else if (key.name === "delete") {
          input.handleKeyPress(key)
          secretValue = `${secretValue.slice(0, offset)}${secretValue.slice(offset + 1)}`
        } else if (!key.ctrl && !key.meta && key.sequence.length > 0) {
          const characters = Array.from(key.sequence.replace(/[\r\n]/g, ""))
          if (characters.length === 0) return
          secretValue = `${secretValue.slice(0, offset)}${characters.join("")}${secretValue.slice(offset)}`
          input.insertText("•".repeat(characters.length))
        } else input.handleKeyPress(key)
      },
      paste: (event) => {
        if (!options.mask) {
          input.handlePaste(event)
          return
        }
        const value = new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, "")
        const offset = input.cursorOffset
        secretValue = `${secretValue.slice(0, offset)}${value}${secretValue.slice(offset)}`
        input.insertText("•".repeat(Array.from(value).length))
      },
    })
    input.cursorOffset = input.value.length
    input.focus()
    renderMask()
  })
}
