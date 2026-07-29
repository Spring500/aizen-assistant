import {
  type CliRenderer,
  CliRenderEvents,
  createTextAttributes,
  type KeyEvent,
  parseColor,
  StyledText,
  type TextChunk,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"
import { shortcutText } from "./status-bar.ts"
import { systemColors } from "./theme.ts"

export type CommandOption = {
  name: `/${string}`
  description: string
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
  error: TextRenderable
  setSessionTitle(session: { name: string; sessionId: string } | undefined): void
  setStatus(content: string): void
  setShortcuts(content: string): void
  setError(content: string): void
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

function titledSeparator(width: number, session: { name: string; sessionId: string } | undefined): StyledText {
  const safeWidth = Math.max(1, width)
  const suffix = "──"
  const availableTitleWidth = Math.max(0, safeWidth - Bun.stringWidth(suffix))
  const id = truncateToCells(session?.sessionId ?? "会话", availableTitleWidth)
  const nameSpace = Math.max(0, availableTitleWidth - Bun.stringWidth(id) - 2)
  const name = session?.name ? truncateToCells(session.name, nameSpace) : ""
  const separator = "─".repeat(
    Math.max(0, safeWidth - Bun.stringWidth(suffix) - Bun.stringWidth(id) - (name ? Bun.stringWidth(name) + 2 : 0)),
  )
  const chunks: TextChunk[] = [{ __isChunk: true, text: separator, fg: parseColor(systemColors.shortcuts) }]
  if (name) {
    chunks.push({
      __isChunk: true,
      text: `${name}  `,
      fg: parseColor(systemColors.header),
      attributes: createTextAttributes({ bold: true }),
    })
  }
  chunks.push({
    __isChunk: true,
    text: id,
    fg: parseColor(systemColors.shortcuts),
    attributes: createTextAttributes({ italic: true, dim: true }),
  })
  chunks.push({ __isChunk: true, text: suffix, fg: parseColor(systemColors.shortcuts) })
  return new StyledText(chunks)
}

export function createChatEditor(
  renderer: CliRenderer,
  handlers: EditorHandlers,
  manager: OverlayManager = overlayManager(renderer),
  commands: readonly CommandOption[] = [],
): ChatEditor {
  let busy = false
  let inputVisible = true
  let sessionTitle: { name: string; sessionId: string } | undefined
  let destroyed = false
  let commandSelected = 0
  let commandDismissedFor = ""
  let commandMatches: CommandOption[] = []

  const commandList = new TextRenderable(renderer, {
    id: "editor-command-list",
    width: "100%",
    height: 0,
    wrapMode: "none",
    truncate: true,
    fg: systemColors.secondary,
    content: "",
    visible: false,
  })
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
  const commandPrefix = () => {
    const value = input.plainText
    const trimmed = value.trimStart()
    if (!trimmed.startsWith("/") || /\s/.test(trimmed) || value.trimEnd() !== value) return undefined
    return trimmed
  }
  const updateCommands = () => {
    const prefix = commandPrefix()
    if (!prefix || commandDismissedFor === input.plainText) commandMatches = []
    else commandMatches = commands.filter((command) => command.name.startsWith(prefix))
    commandSelected = Math.min(commandSelected, Math.max(0, commandMatches.length - 1))
    commandList.visible = inputVisible && commandMatches.length > 0
    commandList.height = commandList.visible ? Math.min(5, commandMatches.length) : 0
    commandList.content = commandMatches
      .slice(0, 5)
      .map(
        (command, index) =>
          `${index === commandSelected ? "▶" : " "} ${command.name.padEnd(10)} ${command.description}`,
      )
      .join("\n")
  }
  const completeCommand = () => {
    const command = commandMatches[commandSelected]
    if (!command) return false
    input.setText(command.name)
    input.cursorOffset = input.plainText.length
    commandDismissedFor = input.plainText
    updateCommands()
    updateLayout()
    return true
  }
  const updateLayout = () => {
    if (destroyed || input.isDestroyed) return
    const measuredLines = inputVisualLines(input.plainText, renderer.terminalWidth)
    const nextHeight = Math.max(
      minInputHeight,
      Math.min(maxInputHeight, Math.max(measuredLines, input.virtualLineCount || input.lineCount || 1)),
    )
    input.height = nextHeight
    updateCommands()
    topSeparator.content = titledSeparator(renderer.terminalWidth, sessionTitle)
    bottomSeparator.content = "─".repeat(Math.max(1, renderer.terminalWidth))
    manager.setBaseFooterHeight(
      chatViewHeight + (inputVisible ? nextHeight + 2 + (commandList.visible ? commandList.height : 0) : 0) + 3,
    )
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
    onContentChange: () => {
      if (commandDismissedFor !== input.plainText) commandDismissedFor = ""
      queueMicrotask(updateLayout)
    },
    onSubmit: () => {
      if (busy) return
      if (commandMatches.length > 0 && completeCommand()) return
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
  renderer.root.add(commandList)
  renderer.root.add(topSeparator)
  renderer.root.add(input)
  renderer.root.add(bottomSeparator)
  renderer.root.add(status)
  const error = new TextRenderable(renderer, {
    id: "editor-error",
    width: "100%",
    height: 1,
    wrapMode: "none",
    truncate: true,
    fg: systemColors.statusError,
    content: "",
  })
  renderer.root.add(shortcuts)
  renderer.root.add(error)
  input.focus()
  updateLayout()

  const onKeyPress = (key: KeyEvent) => {
    if (commandMatches.length > 0 && key.name === "down") {
      key.preventDefault()
      key.stopPropagation()
      commandSelected = (commandSelected + 1) % commandMatches.length
      updateCommands()
      return
    }
    if (commandMatches.length > 0 && key.name === "up") {
      key.preventDefault()
      key.stopPropagation()
      commandSelected = (commandSelected - 1 + commandMatches.length) % commandMatches.length
      updateCommands()
      return
    }
    if (commandMatches.length > 0 && key.name === "tab") {
      key.preventDefault()
      key.stopPropagation()
      completeCommand()
      return
    }
    if (commandMatches.length > 0 && key.name === "escape") {
      key.preventDefault()
      key.stopPropagation()
      commandDismissedFor = input.plainText
      updateCommands()
      updateLayout()
      return
    }
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
    error,
    setSessionTitle(value) {
      sessionTitle = value
      updateLayout()
    },
    setStatus(content) {
      status.content = content
    },
    setShortcuts(content) {
      shortcuts.content = content
    },
    setError(content) {
      error.content = content
    },
    setBusy(value) {
      busy = value
    },
    setInputVisible(value) {
      if (destroyed || input.isDestroyed) return
      inputVisible = value
      input.visible = value
      topSeparator.visible = value
      updateCommands()
      bottomSeparator.visible = value
      if (value) input.focus()
      else input.blur()
      updateLayout()
    },
    destroy() {
      destroyed = true
      renderer.keyInput.off("keypress", onKeyPress)
      renderer.off(CliRenderEvents.RESIZE, onResize)
      commandList.destroy()
      topSeparator.destroy()
      input.destroy()
      bottomSeparator.destroy()
      status.destroy()
      shortcuts.destroy()
      error.destroy()
    },
  }
}
