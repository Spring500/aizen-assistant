import { type CliRenderer, CliRenderEvents, type KeyEvent, TextareaRenderable, TextRenderable } from "@opentui/core"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"
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
  setTitle(title: string): void
  setStatus(content: string): void
  setShortcuts(content: string): void
  setBusy(busy: boolean): void
  setInputVisible(visible: boolean): void
  destroy(): void
}

const minInputHeight = 1
const maxInputHeight = 8
const chatViewHeight = 3

function escapedNewline(input: TextareaRenderable): boolean {
  const value = input.plainText
  const characterOffset = input.cursorCharacterOffset
  if (characterOffset === undefined) return false

  let slashIndex = -1
  if (characterOffset > 0 && value[characterOffset - 1] === "\\") slashIndex = characterOffset - 1
  else if (input.cursorOffset >= value.length && value[characterOffset] === "\\") slashIndex = characterOffset
  if (slashIndex < 0) return false

  const before = value.slice(0, slashIndex)
  input.setText(`${before}\n${value.slice(slashIndex + 1)}`)
  input.setCursor(before.split("\n").length, 0)
  return true
}

function truncateToCells(value: string, width: number): string {
  if (width <= 0) return ""
  let result = ""
  for (const character of value) {
    if (Bun.stringWidth(result + character) > width) break
    result += character
  }
  return result
}

function inputVisualLines(value: string, width: number): number {
  const safeWidth = Math.max(1, width)
  return value.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(Bun.stringWidth(line) / safeWidth)), 0)
}

function titledSeparator(width: number, title: string): string {
  const safeWidth = Math.max(1, width)
  const suffix = "──"
  const availableTitleWidth = Math.max(0, safeWidth - Bun.stringWidth(suffix))
  const label = `${truncateToCells(title, availableTitleWidth)}${suffix}`
  return `${"─".repeat(Math.max(0, safeWidth - Bun.stringWidth(label)))}${label}`
}

export function createChatEditor(
  renderer: CliRenderer,
  handlers: EditorHandlers,
  manager: OverlayManager = overlayManager(renderer),
): ChatEditor {
  let busy = false
  let inputVisible = true
  let title = "会话"
  let destroyed = false

  const topSeparator = new TextRenderable(renderer, {
    id: "editor-top-separator",
    width: "100%",
    height: 1,
    wrapMode: "none",
    truncate: true,
    fg: systemColors.shortcuts,
    content: "",
  })
  let input!: TextareaRenderable
  const updateLayout = () => {
    if (destroyed || input.isDestroyed) return
    const measuredLines = inputVisualLines(input.plainText, renderer.terminalWidth)
    const nextHeight = Math.max(
      minInputHeight,
      Math.min(maxInputHeight, Math.max(measuredLines, input.virtualLineCount || input.lineCount || 1)),
    )
    input.height = nextHeight
    topSeparator.content = titledSeparator(renderer.terminalWidth, title)
    bottomSeparator.content = "─".repeat(Math.max(1, renderer.terminalWidth))
    manager.setBaseFooterHeight(chatViewHeight + (inputVisible ? nextHeight + 2 : 0) + 2)
  }
  input = new TextareaRenderable(renderer, {
    id: "editor",
    height: minInputHeight,
    wrapMode: "word",
    placeholder: "输入消息；Enter 发送，Shift+Enter 或光标前 \\ 后 Enter 换行，Esc 中止",
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "return", shift: true, action: "newline" },
    ],
    onContentChange: () => queueMicrotask(updateLayout),
    onSubmit: () => {
      if (busy) return
      const value = input.plainText
      if (escapedNewline(input)) return
      if (!value.trim()) return
      input.setText("")
      handlers.onSubmit(value)
    },
  })
  const bottomSeparator = new TextRenderable(renderer, {
    id: "editor-bottom-separator",
    width: "100%",
    height: 1,
    wrapMode: "none",
    truncate: true,
    fg: systemColors.shortcuts,
    content: "",
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
  renderer.root.add(topSeparator)
  renderer.root.add(input)
  renderer.root.add(bottomSeparator)
  renderer.root.add(status)
  renderer.root.add(shortcuts)
  input.focus()
  updateLayout()

  const onKeyPress = (key: KeyEvent) => {
    if (key.name === "escape") handlers.onAbort()
    if (key.name === "c" && key.ctrl) handlers.onQuit()
  }
  const onResize = () => queueMicrotask(updateLayout)
  renderer.keyInput.on("keypress", onKeyPress)
  renderer.on(CliRenderEvents.RESIZE, onResize)

  return {
    input,
    status,
    shortcuts,
    setTitle(value) {
      title = value || "会话"
      updateLayout()
    },
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
      if (destroyed || input.isDestroyed) return
      inputVisible = value
      input.visible = value
      topSeparator.visible = value
      bottomSeparator.visible = value
      if (value) input.focus()
      else input.blur()
      updateLayout()
    },
    destroy() {
      destroyed = true
      renderer.keyInput.off("keypress", onKeyPress)
      renderer.off(CliRenderEvents.RESIZE, onResize)
      topSeparator.destroy()
      input.destroy()
      bottomSeparator.destroy()
      status.destroy()
      shortcuts.destroy()
    },
  }
}
