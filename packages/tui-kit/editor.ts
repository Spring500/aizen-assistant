import { type CliRenderer, type KeyEvent, TextareaRenderable, TextRenderable } from "@opentui/core"
import type { CoreStatus } from "../core/types.ts"
import { systemTextColor } from "./theme.ts"

export type ShortcutContext = {
  status: CoreStatus
  hasSession: boolean
}

export function shortcutText(context: ShortcutContext): string {
  const global = "Ctrl+C 退出"
  if (context.status === "running" || context.status === "aborting") return `Esc 中止 | ${global}`
  if (context.status === "authenticating") return `Esc 取消认证 | ${global}`
  if (!context.hasSession) return `↑/↓ 选择 | Enter 确认 | Esc 返回 | ${global}`
  return `Enter 发送 | Ctrl+J 换行 | Esc 中止 | /model 切换模型 | /sessions 会话 | /new 新会话 | /fold 折叠 | /quit 退出 | ${global}`
}

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
    fg: systemTextColor,
    content: "模型：未选择模型 | 上下文：0/未知",
  })
  const shortcuts = new TextRenderable(renderer, {
    id: "editor-shortcuts",
    width: "100%",
    height: 1,
    wrapMode: "none",
    truncate: true,
    fg: systemTextColor,
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
    setVisible(value) {
      input.visible = value
      status.visible = value
      shortcuts.visible = value
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
