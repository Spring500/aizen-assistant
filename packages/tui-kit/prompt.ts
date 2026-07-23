import { type CliRenderer, type KeyEvent, type PasteEvent, TextRenderable } from "@opentui/core"

export type PromptOptions = { mask?: boolean; onCancel?: () => void }

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
      content: label,
    })
    renderer.root.add(display)
    let value = ""
    const render = () => {
      display.content = `${label}${options.mask ? "•".repeat(value.length) : value}`
    }
    const cleanup = () => {
      renderer.keyInput.off("keypress", onKeyPress)
      renderer.keyInput.off("paste", onPaste)
      display.destroy()
    }
    const onKeyPress = (key: KeyEvent) => {
      if (key.name === "return") {
        cleanup()
        resolve(value)
      } else if (key.name === "escape") {
        cleanup()
        options.onCancel?.()
        resolve("")
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
    renderer.keyInput.on("keypress", onKeyPress)
    renderer.keyInput.on("paste", onPaste)
    render()
  })
}
