import { type CliRenderer, type KeyEvent, type PasteEvent, TextRenderable } from "@opentui/core"
import { systemTextColor } from "./theme.ts"

export type PromptOptions = { mask?: boolean; signal?: AbortSignal; onCancel?: () => void }

export function promptLine(
  renderer: CliRenderer,
  id: string,
  label: string,
  options: PromptOptions = {},
): Promise<string> {
  return new Promise((resolve) => {
    const display = new TextRenderable(renderer, {
      id,
      height: 1,
      position: "absolute",
      right: 0,
      bottom: 3,
      left: 0,
      zIndex: 110,
      fg: systemTextColor,
      content: label,
    })
    renderer.root.add(display)
    let value = ""
    let settled = false
    const render = () => {
      display.content = `${label}${options.mask ? "•".repeat(value.length) : value}`
    }
    const cleanup = () => {
      renderer.keyInput.off("keypress", onKeyPress)
      renderer.keyInput.off("paste", onPaste)
      options.signal?.removeEventListener("abort", onAbort)
      display.destroy()
    }
    const finish = (cancelled: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      if (cancelled) options.onCancel?.()
      resolve(cancelled ? "" : value)
    }
    const onKeyPress = (key: KeyEvent) => {
      if (key.name === "return") {
        finish(false)
      } else if (key.name === "escape") {
        finish(true)
      } else if (key.name === "backspace") {
        value = value.slice(0, -1)
        render()
      } else if (!key.ctrl && !key.meta && key.sequence.length === 1) {
        value += key.sequence
        render()
      }
    }
    const onPaste = (event: PasteEvent) => {
      value += new TextDecoder().decode(event.bytes).replace(/\r?\n/g, "")
      render()
    }
    const onAbort = () => finish(true)
    renderer.keyInput.on("keypress", onKeyPress)
    renderer.keyInput.on("paste", onPaste)
    if (options.signal?.aborted) finish(true)
    else options.signal?.addEventListener("abort", onAbort, { once: true })
    render()
  })
}
