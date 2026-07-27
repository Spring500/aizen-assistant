import { type CliRenderer, type KeyEvent, TextareaRenderable, TextRenderable } from "@opentui/core"

export type EditorHandlers = {
  onSubmit(value: string): void
  onAbort(): void
  onQuit(): void
}

export type ChatEditor = {
  input: TextareaRenderable
  status: TextRenderable
  setStatus(content: string): void
  setBusy(busy: boolean): void
  setVisible(visible: boolean): void
  destroy(): void
}

export function createChatEditor(renderer: CliRenderer, handlers: EditorHandlers): ChatEditor {
  let busy = false
  const input = new TextareaRenderable(renderer, {
    id: "editor",
    height: 3,
    placeholder: "输入消息；Enter 发送，Ctrl+J 换行，Esc 中止",
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "j", ctrl: true, action: "newline" },
    ],
    onSubmit: () => {
      if (busy) return
      const value = input.plainText
      if (!value.trim()) return
      input.setText("")
      handlers.onSubmit(value)
    },
  })
  const status = new TextRenderable(renderer, {
    id: "editor-status",
    width: "100%",
    height: 1,
    wrapMode: "none",
    truncate: true,
    content: "模型：未选择模型 | 上下文：0/未知",
  })
  renderer.root.add(input)
  renderer.root.add(status)
  input.focus()

  const onKeyPress = (key: KeyEvent) => {
    if (key.name === "escape") handlers.onAbort()
    if (key.name === "c" && key.ctrl) handlers.onQuit()
  }
  renderer.keyInput.on("keypress", onKeyPress)

  return {
    input,
    status,
    setStatus(content) {
      status.content = content
    },
    setBusy(value) {
      busy = value
    },
    setVisible(value) {
      input.visible = value
      status.visible = value
      if (value) input.focus()
      else input.blur()
    },
    destroy() {
      renderer.keyInput.off("keypress", onKeyPress)
      input.destroy()
      status.destroy()
    },
  }
}
