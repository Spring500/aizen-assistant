import { InputRenderable, TextRenderable } from "@opentui/core"
import type { OverlayHandle, OverlayManager } from "./overlay-manager.ts"
import { systemColors } from "./theme.ts"

export type InlineInputOptions = {
  id: string
  label: string
  initialValue?: string
  placeholder?: string
  top?: number
  mask?: boolean
  validate?: (value: string) => string | undefined
}

/**
 * 在现有页面内容区中打开原生单行输入，并统一处理确认、取消、粘贴和校验反馈。
 */
export function editInline(
  overlays: OverlayManager,
  handle: OverlayHandle,
  options: InlineInputOptions,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    let secretValue = options.initialValue ?? ""
    const top = options.top ?? 0
    const labelWidth = Math.max(1, Bun.stringWidth(options.label))
    const label = new TextRenderable(overlays.renderer, {
      id: `${options.id}-label`,
      position: "absolute",
      top,
      left: 0,
      width: labelWidth,
      height: 1,
      wrapMode: "none",
      truncate: true,
      fg: systemColors.secondary,
      content: options.label,
    })
    const input = new InputRenderable(overlays.renderer, {
      id: `${options.id}-input`,
      position: "absolute",
      top,
      left: labelWidth,
      right: 0,
      value: options.mask ? "•".repeat(Array.from(secretValue).length) : secretValue,
      placeholder: options.placeholder ?? "",
      backgroundColor: "#111827",
      focusedBackgroundColor: "#111827",
      textColor: options.mask ? "#111827" : systemColors.secondary,
      focusedTextColor: options.mask ? "#111827" : systemColors.secondary,
      cursorColor: systemColors.header,
    })
    handle.content.add(label)
    handle.content.add(input)

    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      input.destroy()
      label.destroy()
      resolve(value)
    }
    const confirm = () => {
      const value = options.mask ? secretValue : input.value
      const error = options.validate?.(value)
      if (error) {
        handle.setError(error)
        return
      }
      handle.clearError()
      finish(value)
    }
    handle.setActions([
      { id: "confirm", key: { name: "return" }, label: "Enter 确认", run: confirm },
      { id: "cancel", key: { name: "escape" }, label: "Esc 取消", run: () => finish(undefined) },
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
  })
}
