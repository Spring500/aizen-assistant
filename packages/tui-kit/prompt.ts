import { type CliRenderer, TextRenderable } from "@opentui/core"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"
import { systemColors } from "./theme.ts"

export type PromptOptions = {
  mask?: boolean
  signal?: AbortSignal
  onCancel?: () => void
  initialValue?: string
}

export function promptLine(
  manager: OverlayManager | CliRenderer,
  id: string,
  label: string,
  options: PromptOptions = {},
): Promise<string> {
  const overlays = overlayManager(manager)
  return new Promise((resolve) => {
    let value = options.initialValue ?? ""
    let settled = false
    const handle = overlays.open<string>({
      id,
      title: "",
      help: "Enter 确认 | Esc 取消",
      contentHeight: 1,
      ...(options.signal ? { signal: options.signal } : {}),
      onCancel: () => finish(true),
    })
    const display = new TextRenderable(overlays.renderer, {
      id,
      position: "absolute",
      top: 0,
      right: 0,
      left: 0,
      height: 1,
      wrapMode: "none",
      truncate: true,
      fg: systemColors.secondary,
      content: "",
    })
    handle.content.add(display)
    const render = () => {
      display.content = `${label}${options.mask ? "•".repeat(Array.from(value).length) : value}`
    }
    const finish = (cancelled: boolean) => {
      if (settled) return
      settled = true
      handle.close(cancelled ? undefined : value)
      if (cancelled) options.onCancel?.()
      resolve(cancelled ? "" : value)
    }
    handle.setInput({
      keypress: (key) => {
        if (key.name === "return") finish(false)
        else if (key.name === "escape") finish(true)
        else if (key.name === "backspace") {
          value = Array.from(value).slice(0, -1).join("")
          render()
        } else if (!key.ctrl && !key.meta && key.sequence.length > 0) {
          value += key.sequence
          render()
        }
      },
      paste: (event) => {
        value += new TextDecoder().decode(event.bytes).replace(/[\r\n]+/g, "")
        render()
      },
    })
    render()
  })
}
