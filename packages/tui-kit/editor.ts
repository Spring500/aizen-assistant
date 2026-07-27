import { type CliRenderer, type KeyEvent, TextareaRenderable, TextRenderable } from "@opentui/core"
import { shortcutText } from "./status-bar.ts"
import { systemColors } from "./theme.ts"

export type EditorHandlers = {
  onSubmit(value: string): void
  onAbort(): void
  onQuit(): void
}

export type ChatEditor = {
  input: TextareaRenderable
  status: TextRenderable
  shortcuts: TextRenderable
  setStatus(content: string): void
  setShortcuts(content: string): void
  setBusy(busy: boolean): void
  setInputVisible(visible: boolean): void
  destroy(): void
}

export function createChatEditor(renderer: CliRenderer, handlers: EditorHandlers): ChatEditor {
  let busy = false
  const submitOrNewline = () => {
    if (busy) return
    const value = input.plainText
    if (value.endsWith("\\")) {
      input.setText(`${value.slice(0, -1)}\n`)
      return
    }
    if (!value.trim()) return
    input.setText("")
    handlers.onSubmit(value)
  }
  const input = new TextareaRenderable(renderer, {
    id: "editor",
    height: 3,
    placeholder: "输入消息；Enter 发送，Shift+Enter 或 \\+Enter 换行，Esc 中止",
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "return", shift: true, action: "newline" },
    ],
    onSubmit: submitOrNewline,
  })
  const status = new TextRenderable(renderer, {
    id: "editor-status",
    width: "100%",
    height: 1,
    wrapMode: "none",
    truncate: true,
    fg: systemColors.sessionStatus,
    content: "模型：未选择模型 | 上下文：0/未知",
  })
  const shortcuts = new TextRenderable(renderer, {
    id: "editor-shortcuts",
    width: "100%",
    height: 1,
    wrapMode: "none",
    truncate: true,
    fg: systemColors.shortcuts,
    content: shortcutText({ status: "idle", hasSession: false }),
  })
  renderer.root.add(input)
  renderer.root.add(status)
  renderer.root.add(shortcuts)
  input.focus()

  const onKeyPress = (key: KeyEvent) => {
    if (key.name === "escape") handlers.onAbort()
    if (key.name === "c" && key.ctrl) handlers.onQuit()
  }
  renderer.keyInput.on("keypress", onKeyPress)

  return {
    input,
    status,
    shortcuts,
    setStatus(content) {
      status.content = content
    },
    setShortcuts(content) {
      shortcuts.content = content
    },
    setBusy(value) {
      busy = value
    },
    setInputVisible(value) {
      input.visible = value
      if (value) input.focus()
      else input.blur()
    },
    destroy() {
      renderer.keyInput.off("keypress", onKeyPress)
      input.destroy()
      status.destroy()
      shortcuts.destroy()
    },
  }
}
