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
import { FOOTER_FIXED_ROWS, MIN_INPUT_ROWS, MIN_OUTPUT_ROWS } from "./footer-layout.ts"
import { createOutputPanel, type OutputData } from "./output-panel.ts"
import { shortcutText } from "./status-bar.ts"
import { systemColors } from "./theme.ts"

export type CommandOption = {
  name: `/${string}`
  description: string
}

export type SessionStatus = {
  text: string
  tone: "idle" | "running" | "error"
  /** 本轮回复指标（耗时与生成 token 数），由第二条分割线在状态文本后拼接显示。 */
  metrics?: { startedAt: number; elapsedSeconds: number; outputTokens: number }
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
  setInputText(content: string): void
  setStatus(content: string | StyledText): void
  setShortcuts(content: string): void
  setError(content: string): void
  setBusy(busy: boolean): void
  setInputVisible(visible: boolean): void
  /** 更新第二条分割线内嵌的会话状态（空闲/处理中/错误）。 */
  setSessionStatus(status: SessionStatus): void
  /** 更新 footer 输出区（流式输出与活动工具行）。 */
  setOutput(data: OutputData): void
  destroy(): void
}

const maxInputHeight = 8

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

/** 将毫秒时长格式化为紧凑的时、分、秒文本（与 chat-view 的 formatDurationText 同构）。 */
function compactDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${secs}s`].filter(Boolean).join(" ")
}

/** 第二条分割线：横线在左填充、会话状态文本右对齐，右侧 2 列尾部横线，与第一条分割线内嵌对话标题同构对齐。 */
function sessionStatusSeparator(width: number, status: SessionStatus): StyledText {
  const safeWidth = Math.max(1, width)
  const label = status.text ? ` ${status.text}` : ""
  // 耗时/生成数作为状态的附属信息追加在其后，仅在指标存在时显示。
  const metricsLabel = status.metrics
    ? ` · 耗时 ${compactDuration(status.metrics.elapsedSeconds)} · 生成 ${status.metrics.outputTokens} tokens`
    : ""
  const color =
    status.tone === "error"
      ? systemColors.statusError
      : status.tone === "running"
        ? systemColors.statusRunning
        : systemColors.statusIdle
  // 右侧信息区：状态 + 指标。空间不足时优先保留状态文本，指标从右向左截断。
  const contentWidth = Math.max(0, safeWidth - 2)
  const statusWidth = Bun.stringWidth(label)
  const metricsBudget = Math.max(0, contentWidth - statusWidth)
  const metricsShown = metricsBudget > 0 ? truncateToCells(metricsLabel, metricsBudget) : ""
  const shownWidth = statusWidth + Bun.stringWidth(metricsShown)
  const leading = Math.max(0, contentWidth - shownWidth)
  const chunks: TextChunk[] = [{ __isChunk: true, text: "─".repeat(leading), fg: parseColor(systemColors.shortcuts) }]
  if (status.text)
    chunks.push({
      __isChunk: true,
      text: label,
      fg: parseColor(color),
      attributes: createTextAttributes({ bold: true }),
    })
  if (metricsShown) chunks.push({ __isChunk: true, text: metricsShown, fg: parseColor(systemColors.secondary) })
  chunks.push({ __isChunk: true, text: "──", fg: parseColor(systemColors.shortcuts) })
  return new StyledText(chunks)
}

export function createChatEditor(
  renderer: CliRenderer,
  handlers: EditorHandlers,
  commands: readonly CommandOption[] = [],
): ChatEditor {
  let busy = false
  let inputVisible = true
  let sessionTitle: { name: string; sessionId: string } | undefined
  let sessionStatus: SessionStatus = { text: "", tone: "idle" }
  let destroyed = false
  let commandSelected = 0
  let commandOffset = 0
  let commandFilter = ""
  let commandDismissedFor = ""
  let commandMatches: CommandOption[] = []

  const outputPanel = createOutputPanel(renderer)
  renderer.root.add(outputPanel.root, 0)

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
  const updateCommands = (maximumVisibleRows: number) => {
    const prefix = commandPrefix() ?? ""
    if (prefix !== commandFilter) {
      commandFilter = prefix
      commandSelected = 0
      commandOffset = 0
    }
    if (!prefix || commandDismissedFor === input.plainText) commandMatches = []
    else commandMatches = commands.filter((command) => command.name.startsWith(prefix))
    commandSelected = Math.min(commandSelected, Math.max(0, commandMatches.length - 1))
    // 可见候选数按容器高度自适应（不再写死 5）：候选足够时填满输出区高度。
    const visibleRows = Math.min(commandMatches.length, Math.max(0, maximumVisibleRows))
    if (visibleRows > 0) {
      const centeredOffset = commandSelected - Math.floor(visibleRows / 2)
      commandOffset = Math.max(0, Math.min(centeredOffset, commandMatches.length - visibleRows))
    } else commandOffset = 0
    commandList.visible = inputVisible && visibleRows > 0
    // 命令补全替换输出区时必须与输出区等高（占满输出区高度），否则 footer 底部出现空白。
    commandList.height = commandList.visible ? Math.max(1, maximumVisibleRows) : 0
    commandList.content = commandMatches
      .slice(commandOffset, commandOffset + visibleRows)
      .map(
        (command, index) =>
          `${commandOffset + index === commandSelected ? "▶" : " "} ${command.name.padEnd(10)} ${command.description}`,
      )
      .join("\n")
    // 命令补全激活时替换输出区，二者互斥。
    outputPanel.setVisible(!commandList.visible)
  }
  const completeCommand = () => {
    const command = commandMatches[commandSelected]
    if (!command) return false
    input.setText(command.name)
    input.cursorOffset = input.plainText.length
    commandDismissedFor = input.plainText
    updateLayout()
    return true
  }
  const updateLayout = () => {
    if (destroyed || input.isDestroyed) return
    const measuredLines = inputVisualLines(input.plainText, renderer.terminalWidth)
    // 矮终端降级：footer 高度不足以容纳“固定 5 + 输入 1 + 输出区保底 3”时，先隐藏快捷键提示行。
    const shortcutsVisible = renderer.footerHeight >= FOOTER_FIXED_ROWS + MIN_INPUT_ROWS + MIN_OUTPUT_ROWS
    shortcuts.visible = shortcutsVisible
    const fixedRows = shortcutsVisible ? FOOTER_FIXED_ROWS : FOOTER_FIXED_ROWS - 1
    // 输入区按内容行数取，但不多吃：上限 = footer 总高 - 固定行 - 输出区最小行。
    const maxInputRows = Math.max(MIN_INPUT_ROWS, renderer.footerHeight - fixedRows - MIN_OUTPUT_ROWS)
    const nextHeight = Math.max(
      MIN_INPUT_ROWS,
      Math.min(maxInputHeight, maxInputRows, Math.max(measuredLines, input.virtualLineCount || input.lineCount || 1)),
    )
    input.height = nextHeight
    // 剩余空间全部给输出区（含命令补全），输出区保底 3 行。
    const outputHeight = Math.max(MIN_OUTPUT_ROWS, renderer.footerHeight - fixedRows - nextHeight)
    outputPanel.setHeight(outputHeight)
    updateCommands(inputVisible ? outputHeight : 0)
    topSeparator.content = titledSeparator(renderer.terminalWidth, sessionTitle)
    bottomSeparator.content = sessionStatusSeparator(renderer.terminalWidth, sessionStatus)
  }
  input = new TextareaRenderable(renderer, {
    id: "editor",
    height: MIN_INPUT_ROWS,
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
      updateLayout()
      return
    }
    if (commandMatches.length > 0 && key.name === "up") {
      key.preventDefault()
      key.stopPropagation()
      commandSelected = (commandSelected - 1 + commandMatches.length) % commandMatches.length
      updateLayout()
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
    setInputText(content) {
      input.setText(content)
      input.cursorOffset = input.plainText.length
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
      if (destroyed || input.isDestroyed) return
      // 运行中输入区保持可见可输入，仅将输入文字切换为暗淡主题色表达“不可发送”。
      // 恢复时还原 Textarea 默认亮色（#ffffff）。
      const dimColor = value ? systemColors.secondary : "#ffffff"
      input.textColor = dimColor
      input.focusedTextColor = dimColor
    },
    setInputVisible(value) {
      if (destroyed || input.isDestroyed || inputVisible === value) return
      inputVisible = value
      input.visible = value
      topSeparator.visible = value
      bottomSeparator.visible = value
      if (value) input.focus()
      else input.blur()
      updateLayout()
    },
    setSessionStatus(statusValue) {
      sessionStatus = statusValue
      if (destroyed) return
      bottomSeparator.content = sessionStatusSeparator(renderer.terminalWidth, sessionStatus)
    },
    setOutput(data) {
      outputPanel.update(data)
    },
    destroy() {
      destroyed = true
      renderer.keyInput.off("keypress", onKeyPress)
      renderer.off(CliRenderEvents.RESIZE, onResize)
      outputPanel.destroy()
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
