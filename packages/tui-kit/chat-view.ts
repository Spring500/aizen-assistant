import {
  BoxRenderable,
  CodeRenderable,
  type CliRenderer,
  CliRenderEvents,
  createTextAttributes,
  type MarkdownOptions,
  MarkdownRenderable,
  parseColor,
  type RenderContext,
  StyledText,
  SyntaxStyle,
  type TextChunk,
  TextRenderable,
  infoStringToFiletype,
} from "@opentui/core"
import type { FoldPreferences } from "../core/app-preferences-store.ts"
import type { Timing, ToolCallPart, ToolMessage } from "../core/session-format.ts"
import type { CoreSnapshot } from "../core/types.ts"
import { isMathCodeBlock, prepareMarkdownForTerminal } from "./markdown.ts"
import { systemColors } from "./theme.ts"

export type ChatView = {
  destroy(): Promise<void>
  update(snapshot: CoreSnapshot): Promise<void>
  getFoldPreferences(): FoldPreferences
  /** 应用折叠设置并全量回放；message 保留以兼容旧调用，footer 不再展示该提示文案。 */
  setFoldPreferences(fold: FoldPreferences, message?: string): Promise<void>
}

type ToolDisplay = {
  id: string
  name: string
  intent?: string
  input: string
  output: string
  timeoutSeconds?: number
  isError: boolean
  waiting: boolean
  timing?: Timing
}

type DisplayBlock =
  | { kind: "plain"; id: string; turnId: string; content: string }
  | { kind: "user"; id: string; turnId: string; content: string }
  | { kind: "assistant"; id: string; turnId: string; content: string; timing?: Timing }
  | { kind: "thinking"; id: string; turnId: string; content: string; timing?: Timing }
  | { kind: "tool_group"; id: string; turnId: string; tools: ToolDisplay[]; timing?: Timing }

const blockColors = {
  plain: "#252936",
  user: "#66551a",
  assistant: "#1f2937",
  thinking: "#252936",
  tool: "#292c31",
  toolGroup: "#292c31",
} as const

type AssistantMarkdownStyles = {
  markdown: SyntaxStyle
  code: SyntaxStyle
}

function createAssistantMarkdownStyles(): AssistantMarkdownStyles {
  const markdownBackground = blockColors.assistant
  const codeBackground = blockColors.tool
  return {
    markdown: SyntaxStyle.fromStyles({
      default: { fg: "#f3f4f6", bg: markdownBackground },
      conceal: { fg: systemColors.secondary, bg: markdownBackground, dim: true },
      "markup.heading": { fg: systemColors.header, bg: markdownBackground, bold: true },
      "markup.heading.1": { fg: "#f472b6", bg: markdownBackground, bold: true },
      "markup.heading.2": { fg: "#22d3ee", bg: markdownBackground, bold: true },
      "markup.heading.3": { fg: "#a78bfa", bg: markdownBackground, bold: true },
      "markup.heading.4": { fg: "#c4b5fd", bg: markdownBackground, bold: true },
      "markup.heading.5": { fg: "#d8b4fe", bg: markdownBackground, bold: true },
      "markup.heading.6": { fg: "#e9d5ff", bg: markdownBackground, bold: true, dim: true },
      "markup.strong": { fg: "#f3f4f6", bg: markdownBackground, bold: true },
      "markup.italic": { fg: "#f3f4f6", bg: markdownBackground, italic: true },
      "markup.strikethrough": { fg: "#f3f4f6", bg: markdownBackground, dim: true },
      "markup.raw": { fg: systemColors.live, bg: markdownBackground },
      "markup.link": { fg: systemColors.sessionStatus, bg: markdownBackground, underline: true },
      "markup.link.label": { fg: systemColors.sessionStatus, bg: markdownBackground, underline: true },
      "markup.link.url": { fg: systemColors.secondary, bg: markdownBackground, underline: true },
      "markup.quote": { fg: systemColors.secondary, bg: markdownBackground, italic: true },
      "markup.list": { fg: systemColors.header, bg: markdownBackground, bold: true },
      "punctuation.special": { fg: systemColors.secondary, bg: markdownBackground },
    }),
    code: SyntaxStyle.fromStyles({
      default: { fg: "#d1d5db", bg: codeBackground },
      keyword: { fg: "#f472b6", bg: codeBackground, bold: true },
      string: { fg: "#86efac", bg: codeBackground },
      number: { fg: "#facc15", bg: codeBackground },
      boolean: { fg: "#facc15", bg: codeBackground, bold: true },
      comment: { fg: "#9ca3af", bg: codeBackground, italic: true, dim: true },
      type: { fg: "#60a5fa", bg: codeBackground },
      "type.builtin": { fg: "#60a5fa", bg: codeBackground, bold: true },
      function: { fg: "#c4b5fd", bg: codeBackground },
      "function.call": { fg: "#c4b5fd", bg: codeBackground },
      "function.method": { fg: "#c4b5fd", bg: codeBackground },
      "function.method.call": { fg: "#c4b5fd", bg: codeBackground },
      property: { fg: "#67e8f9", bg: codeBackground },
      "variable.builtin": { fg: "#fb923c", bg: codeBackground },
      "variable.member": { fg: "#67e8f9", bg: codeBackground },
      operator: { fg: "#f9a8d4", bg: codeBackground },
      "punctuation.bracket": { fg: systemColors.secondary, bg: codeBackground },
      "punctuation.delimiter": { fg: systemColors.secondary, bg: codeBackground },
    }),
  }
}

function createAssistantMarkdownRenderer(
  context: RenderContext,
  id: string,
  content: string,
  styles: AssistantMarkdownStyles,
): MarkdownRenderable {
  const renderNode: NonNullable<MarkdownOptions["renderNode"]> & { codeBlockOnly?: boolean } = (token) => {
    if (token.type !== "code") return undefined
    if (isMathCodeBlock(token)) {
      return new TextRenderable(context, {
        id: `${id}-formula`,
        content: token.text,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        fg: "#facc15",
        bg: blockColors.tool,
        paddingLeft: 2,
        paddingRight: 2,
      })
    }
    const filetype = infoStringToFiletype(token.lang ?? "")
    return new CodeRenderable(context, {
      id: `${id}-code`,
      content: token.text,
      syntaxStyle: styles.code,
      width: "100%",
      wrapMode: "word",
      fg: "#d1d5db",
      bg: blockColors.tool,
      paddingLeft: 1,
      paddingRight: 1,
      drawUnstyledText: true,
      ...(filetype ? { filetype } : {}),
    })
  }
  renderNode.codeBlockOnly = true

  return new MarkdownRenderable(context, {
    id,
    content: prepareMarkdownForTerminal(content),
    syntaxStyle: styles.markdown,
    width: "100%",
    fg: "#f3f4f6",
    bg: blockColors.assistant,
    streaming: false,
    tableOptions: { widthMode: "content" },
    renderNode,
  })
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function oneLine(value: string): string {
  return value.replace(/\r?\n/g, " ↵ ").replace(/\s+/g, " ").trim()
}

function jsonPreview(value: unknown): string {
  try {
    const serialized = JSON.stringify(value) ?? String(value)
    return serialized.length > 200 ? `${serialized.slice(0, 197)}...` : serialized
  } catch {
    return String(value)
  }
}

function toolInputText(name: string, argumentsValue: unknown): string {
  const argumentsObject = objectValue(argumentsValue)
  if (name === "bash" && typeof argumentsObject?.command === "string") return oneLine(argumentsObject.command)
  if (name === "read" && typeof argumentsObject?.path === "string") {
    const options = [
      typeof argumentsObject.offset === "number" ? `第 ${argumentsObject.offset} 行起` : "",
      typeof argumentsObject.limit === "number" ? `最多 ${argumentsObject.limit} 行` : "",
    ].filter(Boolean)
    return `${oneLine(argumentsObject.path)}${options.length > 0 ? ` · ${options.join(" · ")}` : ""}`
  }
  if (name === "edit" && typeof argumentsObject?.path === "string") {
    const editCount = Array.isArray(argumentsObject.edits) ? argumentsObject.edits.length : 0
    return `${oneLine(argumentsObject.path)} · ${editCount} 处修改`
  }
  if (name === "write" && typeof argumentsObject?.path === "string") {
    const contentLength = typeof argumentsObject.content === "string" ? argumentsObject.content.length : 0
    return `${oneLine(argumentsObject.path)} · 写入 ${contentLength} 字符`
  }
  return jsonPreview(argumentsValue)
}

/** 将毫秒时长格式化为紧凑的天、时、分、秒文本。 */
export function formatDurationText(durationMs: number): string {
  let seconds = Math.max(0, Math.floor(durationMs / 1000))
  const days = Math.floor(seconds / 86400)
  seconds %= 86400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${seconds}s`]
    .filter(Boolean)
    .join(" ")
}

/** 将毫秒时间戳格式化为固定宽度的本地时间文本。 */
export function formatTimestampText(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function timingText(timing: Timing | undefined): string {
  return timing
    ? `${formatDurationText(timing.finishedAt - timing.startedAt)} · ${formatTimestampText(timing.finishedAt)}`
    : ""
}

function lastOutputLine(text: string): { lastLine: string; omitted: boolean } {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "")
  if (!normalized) return { lastLine: "", omitted: false }
  const lines = normalized.split("\n")
  return { lastLine: lines.at(-1) ?? "", omitted: lines.length > 1 }
}

function outputPreview(text: string): string {
  const result = lastOutputLine(text)
  if (!result.lastLine) return "（无文本输出）"
  return `${result.omitted ? "..." : ""}${result.lastLine}`
}

function toolMessageText(message: ToolMessage): string {
  const text = message.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
  return outputPreview(text)
}

function toolDisplay(call: ToolCallPart, result: ToolMessage | undefined): ToolDisplay {
  const argumentsObject = objectValue(call.arguments)
  return {
    id: call.callId,
    name: call.name,
    ...(call.declaredIntent ? { intent: call.declaredIntent } : {}),
    input: toolInputText(call.name, call.arguments),
    output: result ? toolMessageText(result) : "等待结果",
    ...(typeof argumentsObject?.timeout === "number" ? { timeoutSeconds: argumentsObject.timeout } : {}),
    isError: result?.isError ?? false,
    waiting: result === undefined,
    ...(result?.timing ? { timing: result.timing } : {}),
  }
}

function groupTiming(tools: ToolDisplay[]): Timing | undefined {
  const timings = tools.flatMap((tool) => (tool.timing ? [tool.timing] : []))
  if (timings.length === 0) return undefined
  return {
    startedAt: Math.min(...timings.map((item) => item.startedAt)),
    finishedAt: Math.max(...timings.map((item) => item.finishedAt)),
  }
}

function mergeConsecutiveToolGroups(blocks: DisplayBlock[]): DisplayBlock[] {
  const merged: DisplayBlock[] = []
  for (const block of blocks) {
    const previous = merged.at(-1)
    if (block.kind !== "tool_group" || previous?.kind !== "tool_group" || previous.turnId !== block.turnId) {
      merged.push(block)
      continue
    }
    const tools = [...previous.tools, ...block.tools]
    const timing = groupTiming(tools)
    merged[merged.length - 1] = {
      kind: "tool_group",
      id: `tools-${tools.map((tool) => tool.id).join("-")}`,
      turnId: block.turnId,
      tools,
      ...(timing ? { timing } : {}),
    }
  }
  return merged
}

function displayBlocks(snapshot: CoreSnapshot): DisplayBlock[] {
  const results = new Map<string, ToolMessage>()
  const calls = new Set<string>()
  for (const entry of snapshot.transcript) {
    if (entry.type !== "message") continue
    if (entry.message.role === "tool") results.set(entry.message.callId, entry.message)
    else for (const part of entry.message.parts) if (part.kind === "tool_call") calls.add(part.callId)
  }

  const blocks: DisplayBlock[] = []
  for (const [entryIndex, entry] of snapshot.transcript.entries()) {
    if (entry.type === "environment") {
      blocks.push({
        kind: "plain",
        id: `environment-${entry.recordId}`,
        turnId: `environment-${entry.recordId}`,
        content: entry.text,
      })
    } else if (entry.type === "input") {
      for (const [itemIndex, item] of entry.items.entries()) {
        const text = item.parts
          .filter((part) => part.kind === "text")
          .map((part) => part.text)
          .join("\n")
        blocks.push({
          kind: item.source === "user" ? "user" : "plain",
          id: `input-${entry.turnId}-${itemIndex}`,
          turnId: entry.turnId,
          content: item.source === "user" ? `[你] ${text}` : `[额外消息:${item.source}] ${text}`,
        })
      }
    } else if (entry.type === "message") {
      if (entry.message.role === "assistant") {
        const tools: ToolDisplay[] = []
        for (const [partIndex, part] of entry.message.parts.entries()) {
          if (part.kind === "text")
            blocks.push({
              kind: "assistant",
              id: `assistant-${entry.turnId}-${entryIndex}-${partIndex}`,
              turnId: entry.turnId,
              content: part.text,
              ...(part.timing ? { timing: part.timing } : {}),
            })
          else if (part.kind === "thinking")
            blocks.push({
              kind: "thinking",
              id: `thinking-${entry.turnId}-${entryIndex}-${partIndex}`,
              turnId: entry.turnId,
              content: part.text,
              ...(part.timing ? { timing: part.timing } : {}),
            })
          else tools.push(toolDisplay(part, results.get(part.callId)))
        }
        if (tools.length > 0) {
          const timing = groupTiming(tools)
          blocks.push({
            kind: "tool_group",
            id: `tools-${tools.map((tool) => tool.id).join("-")}`,
            turnId: entry.turnId,
            tools,
            ...(timing ? { timing } : {}),
          })
        }
      } else if (!calls.has(entry.message.callId)) {
        const tool: ToolDisplay = {
          id: entry.message.callId,
          name: entry.message.name,
          input: "未知调用参数",
          output: toolMessageText(entry.message),
          isError: entry.message.isError,
          waiting: false,
          ...(entry.message.timing ? { timing: entry.message.timing } : {}),
        }
        blocks.push({
          kind: "tool_group",
          id: `tools-${entry.message.callId}`,
          turnId: entry.turnId,
          tools: [tool],
          ...(tool.timing ? { timing: tool.timing } : {}),
        })
      }
    } else if (entry.outcome !== "completed") {
      blocks.push({
        kind: "plain",
        id: `outcome-${entry.turnId}`,
        turnId: entry.turnId,
        content: entry.outcome === "aborted" ? "[已中止]" : "[执行失败]",
      })
    }
  }
  return mergeConsecutiveToolGroups(blocks)
}

function makeBox(context: RenderContext, id: string, color: string, marginBottom = 0): BoxRenderable {
  return new BoxRenderable(context, {
    id,
    width: "100%",
    height: "auto",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1,
    paddingBottom: 1,
    marginBottom,
    backgroundColor: color,
  })
}

function makeText(context: RenderContext, id: string, content: string | StyledText, color: string): TextRenderable {
  return new TextRenderable(context, {
    id,
    width: color === blockColors.tool ? "100%" : "auto",
    height: "auto",
    wrapMode: color === blockColors.tool ? "none" : "word",
    truncate: color === blockColors.tool,
    bg: color,
    content,
  })
}

function styledToolText(tool: ToolDisplay, detailsExpanded: boolean): StyledText {
  const chunks: TextChunk[] = []
  const push = (text: string, color: string, attributes: { bold?: boolean; italic?: boolean; dim?: boolean } = {}) => {
    chunks.push({
      __isChunk: true,
      text,
      fg: parseColor(color),
      attributes: createTextAttributes(attributes),
    })
  }
  push(`[${tool.name}]`, systemColors.secondary, { bold: true })
  push(tool.intent ? `  ${tool.intent}` : "  未提供调用目的", systemColors.header, { bold: !!tool.intent })
  const metadata = [
    tool.timeoutSeconds === undefined ? "" : `限时 ${formatDurationText(tool.timeoutSeconds * 1000)}`,
    tool.timing ? timingText(tool.timing) : "",
  ].filter(Boolean)
  if (metadata.length > 0) push(`  ·  ${metadata.join(" · ")}`, systemColors.secondary, { dim: true })
  if (detailsExpanded) {
    push("\n  › ", systemColors.secondary, { dim: true })
    push(tool.input, systemColors.secondary, { dim: true, italic: true })
    push(
      `\n  ${tool.waiting ? "…" : tool.isError ? "×" : "✓"} `,
      tool.isError ? systemColors.statusError : systemColors.secondary,
      {
        dim: !tool.isError,
      },
    )
    push(tool.output, tool.isError ? systemColors.statusError : systemColors.secondary, {
      dim: !tool.isError,
      italic: true,
    })
  }
  return new StyledText(chunks)
}

function createHistoryBlock(
  context: RenderContext,
  index: number,
  block: DisplayBlock,
  fold: FoldPreferences,
  assistantMarkdownStyles: AssistantMarkdownStyles,
): BoxRenderable {
  const rootId = `history-entry-${index}`
  if (block.kind === "plain") {
    const root = makeBox(context, rootId, blockColors.plain)
    root.add(makeText(context, `${rootId}-text`, block.content, blockColors.plain))
    return root
  }
  if (block.kind === "user") {
    const root = makeBox(context, rootId, blockColors.user)
    root.add(makeText(context, `${rootId}-text`, block.content, blockColors.user))
    return root
  }
  if (block.kind === "assistant" || block.kind === "thinking") {
    const isThinking = block.kind === "thinking"
    const color = isThinking ? blockColors.thinking : blockColors.assistant
    const isExpanded = !isThinking || fold.thinkingExpanded
    const label = isThinking ? "思考" : "助手"
    const meta = timingText(block.timing)
    const root = makeBox(context, rootId, color)
    if (!isExpanded || isThinking) {
      const content = isExpanded
        ? `▼ ${label}${meta ? `  ${meta}` : ""}\n${block.content}`
        : `▶ ${label} ${oneLine(block.content).slice(0, 80)}...${meta ? `  ${meta}` : ""}`
      root.add(makeText(context, `${rootId}-text`, content, color))
      return root
    }
    root.add(makeText(context, `${rootId}-header`, `▼ ${label}${meta ? `  ${meta}` : ""}`, color))
    root.add(createAssistantMarkdownRenderer(context, `${rootId}-markdown`, block.content, assistantMarkdownStyles))
    return root
  }

  const root = makeBox(context, rootId, blockColors.toolGroup)
  const groupExpanded = fold.toolGroupExpanded
  const detailsExpanded = groupExpanded && fold.toolDetailsExpanded
  const names = block.tools.map((tool) => tool.name).join(" / ")
  const meta = timingText(block.timing)
  root.add(
    makeText(
      context,
      `${rootId}-header`,
      `${groupExpanded ? "▼" : "▶"} ${block.tools.length} 个工具调用：${names}${meta ? `  ${meta}` : ""}`,
      blockColors.toolGroup,
    ),
  )
  if (!groupExpanded) return root

  for (const [toolIndex, tool] of block.tools.entries()) {
    const toolRoot = new BoxRenderable(context, {
      id: `${rootId}-tool-${toolIndex}`,
      width: "100%",
      height: "auto",
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: blockColors.tool,
    })
    toolRoot.add(
      makeText(context, `${rootId}-tool-${toolIndex}-text`, styledToolText(tool, detailsExpanded), blockColors.tool),
    )
    root.add(toolRoot)
  }
  return root
}

export function createChatView(renderer: CliRenderer): ChatView {
  const assistantMarkdownStyles = createAssistantMarkdownStyles()
  let blocks: DisplayBlock[] = []
  let fold: FoldPreferences = {
    thinkingExpanded: false,
    toolGroupExpanded: false,
    toolDetailsExpanded: false,
  }
  let committedFingerprints: string[] = []
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  let operationQueue = Promise.resolve()
  let lifecycle: "active" | "closing" | "destroyed" = "active"
  let destroyPromise: Promise<void> | undefined

  const renderedFingerprints = () => blocks.map((block) => JSON.stringify({ block, fold }))

  const commitBlocks = async (startIndex: number) => {
    if (startIndex >= blocks.length) return
    const surface = renderer.createScrollbackSurface()
    try {
      for (let index = startIndex; index < blocks.length; index += 1) {
        const block = blocks[index] as DisplayBlock
        surface.root.add(createHistoryBlock(surface.renderContext, index, block, fold, assistantMarkdownStyles))
      }
      await surface.settle()
      surface.commitRows(0, surface.height)
    } finally {
      surface.destroy()
    }
  }

  const syncHistory = async (forceReplay = false) => {
    if (lifecycle !== "active") return
    const nextFingerprints = renderedFingerprints()
    if (
      !forceReplay &&
      nextFingerprints.length === committedFingerprints.length &&
      nextFingerprints.every((value, index) => committedFingerprints[index] === value)
    )
      return
    const canAppend =
      !forceReplay &&
      nextFingerprints.length >= committedFingerprints.length &&
      committedFingerprints.every((value, index) => nextFingerprints[index] === value)
    if (canAppend) await commitBlocks(committedFingerprints.length)
    else {
      try {
        renderer.resetSplitFooterForReplay({ clearSavedLines: true })
      } catch (error) {
        // OpenTUI 的离屏测试渲染器没有活动终端，无法执行 ANSI 清屏；仍继续提交回放快照。
        if (!(error instanceof Error) || error.message !== "resetSplitFooterForReplay requires an active terminal")
          throw error
      }
      await commitBlocks(0)
    }
    if (lifecycle !== "active") return
    committedFingerprints = nextFingerprints
  }

  const queueOperation = (operation: () => void | Promise<void>): Promise<void> => {
    if (lifecycle !== "active") return Promise.resolve()
    const result = operationQueue.then(async () => {
      if (lifecycle !== "active") return
      await operation()
    })
    operationQueue = result.catch(() => {})
    return result
  }

  const onResize = () => {
    if (lifecycle !== "active") return
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined
      void queueOperation(async () => {
        await syncHistory(true)
      }).catch((error) => console.error("聊天视图 resize 回放失败", error))
    }, 75)
  }
  renderer.on(CliRenderEvents.RESIZE, onResize)

  return {
    destroy() {
      if (destroyPromise) return destroyPromise
      lifecycle = "closing"
      if (resizeTimer) {
        clearTimeout(resizeTimer)
        resizeTimer = undefined
      }
      renderer.off(CliRenderEvents.RESIZE, onResize)
      destroyPromise = operationQueue.then(() => {
        assistantMarkdownStyles.markdown.destroy()
        assistantMarkdownStyles.code.destroy()
        lifecycle = "destroyed"
      })
      return destroyPromise
    },
    update(snapshot) {
      return queueOperation(async () => {
        fold = { ...snapshot.preferences.fold }
        blocks = displayBlocks(snapshot)
        await syncHistory()
      })
    },
    getFoldPreferences() {
      return { ...fold }
    },
    setFoldPreferences(next, _message) {
      return queueOperation(async () => {
        fold = { ...next }
        await syncHistory(true)
      })
    },
  }
}
