import {
  BoxRenderable,
  type CliRenderer,
  CliRenderEvents,
  createTextAttributes,
  parseColor,
  type RenderContext,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import type { FoldPreferences } from "../core/app-preferences-store.ts"
import type { Timing, ToolCallPart, ToolMessage } from "../core/session-format.ts"
import type { CoreSnapshot } from "../core/types.ts"
import {
  type AssistantMarkdownStyles,
  createAssistantMarkdownRenderer,
  createAssistantMarkdownStyles,
} from "./markdown-renderer.ts"
import { blockColors, systemColors } from "./theme.ts"

export type ChatView = {
  destroy(): Promise<void>
  update(snapshot: CoreSnapshot): Promise<void>
  getFoldPreferences(): FoldPreferences
  /** 应用折叠设置并全量回放；message 保留以兼容旧调用，footer 不再展示该提示文案。 */
  setFoldPreferences(fold: FoldPreferences, message?: string): Promise<void>
  /** 终端配色切换后的全量重放：重建 markdown 样式并重绘历史。 */
  refreshTheme(): Promise<void>
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

function displayBlocks(snapshot: CoreSnapshot): DisplayBlock[] {
  const blocks: DisplayBlock[] = []
  // 转录中出现的全部工具调用 callId，用于识别孤儿工具结果（无对应调用记录）。
  const calls = new Set<string>()
  for (const entry of snapshot.transcript) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue
    for (const part of entry.message.parts) if (part.kind === "tool_call") calls.add(part.callId)
  }
  // 每个轮次已发出、尚未归档的工具调用（保持调用顺序）。
  const pending = new Map<string, ToolCallPart[]>()
  // 按转录顺序到达的工具结果（callId → 结果消息）。
  const results = new Map<string, ToolMessage>()
  const pendingOf = (turnId: string): ToolCallPart[] => {
    const list = pending.get(turnId) ?? []
    pending.set(turnId, list)
    return list
  }
  // 将一组工具生成一个一次成型的工具组块。
  const pushToolGroup = (turnId: string, tools: ToolDisplay[]): void => {
    if (tools.length === 0) return
    const timing = groupTiming(tools)
    blocks.push({
      kind: "tool_group",
      id: `tools-${tools.map((tool) => tool.id).join("-")}`,
      turnId,
      tools,
      ...(timing ? { timing } : {}),
    })
  }
  // 思考/对话段边界：把该轮“结果已到达但尚未归档”的工具归档为组块（先工具后文本）。
  const archiveCompleted = (turnId: string): void => {
    const list = pendingOf(turnId)
    const done = list.filter((call) => results.has(call.callId))
    if (done.length === 0) return
    pushToolGroup(
      turnId,
      done.map((call) => toolDisplay(call, results.get(call.callId))),
    )
    pending.set(
      turnId,
      list.filter((call) => !results.has(call.callId)),
    )
  }
  // 轮次结束兜底：归档该轮剩余工具，无结果的标记未响应。
  const archiveRemaining = (turnId: string): void => {
    const list = pendingOf(turnId)
    if (list.length === 0) return
    pushToolGroup(
      turnId,
      list.map((call) => {
        const result = results.get(call.callId)
        if (result) return toolDisplay(call, result)
        return {
          id: call.callId,
          name: call.name,
          ...(call.declaredIntent ? { intent: call.declaredIntent } : {}),
          input: toolInputText(call.name, call.arguments),
          output: "未响应（本轮已中止/失败）",
          isError: true,
          waiting: false,
        }
      }),
    )
    pending.delete(turnId)
  }

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
        // 思考/对话段边界：先归档此前结果已到达、尚未归档的工具（先工具后思考/文本）。
        archiveCompleted(entry.turnId)
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
          else if (part.kind === "tool_call") pendingOf(entry.turnId).push(part)
        }
      } else if (!calls.has(entry.message.callId)) {
        // 孤儿工具结果（转录中无对应调用记录）：独立归档。
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
      } else {
        // 工具结果到达：登记结果，等下一个段边界/轮次兜底时随组块归档。
        results.set(entry.message.callId, entry.message)
      }
    } else if (entry.type === "turn_end") {
      // 轮次结束：归档该轮剩余工具（含无结果的中断调用），再输出轮次结果提示。
      archiveRemaining(entry.turnId)
      if (entry.outcome !== "completed") {
        blocks.push({
          kind: "plain",
          id: `outcome-${entry.turnId}`,
          turnId: entry.turnId,
          content: entry.outcome === "aborted" ? "[已中止]" : "[执行失败]",
        })
      }
    }
  }
  return blocks
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
  push(`[${tool.name}]`, systemColors.dim, { bold: true })
  push(tool.intent ? `  ${tool.intent}` : "  未提供调用目的", systemColors.accent, { bold: !!tool.intent })
  const metadata = [
    tool.timeoutSeconds === undefined ? "" : `限时 ${formatDurationText(tool.timeoutSeconds * 1000)}`,
    tool.timing ? timingText(tool.timing) : "",
  ].filter(Boolean)
  if (metadata.length > 0) push(`  ·  ${metadata.join(" · ")}`, systemColors.dim, { dim: true })
  // 详情折叠时也要让失败可见：行尾追加失败标记，避免失败被隐藏成“无结果”。
  if (!detailsExpanded && tool.isError) push("  ×", systemColors.error, { bold: true })
  if (detailsExpanded) {
    push("\n  › ", systemColors.dim, { dim: true })
    push(tool.input, systemColors.dim, { dim: true, italic: true })
    push(
      `\n  ${tool.waiting ? "…" : tool.isError ? "×" : "✓"} `,
      tool.isError ? systemColors.error : systemColors.dim,
      {
        dim: !tool.isError,
      },
    )
    push(tool.output, tool.isError ? systemColors.error : systemColors.dim, {
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
  let assistantMarkdownStyles = createAssistantMarkdownStyles()
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
  /** 上次构建 blocks 的 transcript 长度；流式期间 transcript 不变，用于跳过全量重算。 */
  let lastTranscriptLength = -1

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
        const nextFold = { ...snapshot.preferences.fold }
        // 流式期间（transcript 与折叠偏好均未变化）历史块无需重建：
        // 每次 delta 都全量 displayBlocks + JSON.stringify 指纹会随会话线性放大，
        // 是回复中后段卡顿的主要来源，这里直接跳过。
        const transcriptUnchanged =
          blocks.length > 0 &&
          snapshot.transcript.length === lastTranscriptLength &&
          nextFold.thinkingExpanded === fold.thinkingExpanded &&
          nextFold.toolGroupExpanded === fold.toolGroupExpanded &&
          nextFold.toolDetailsExpanded === fold.toolDetailsExpanded
        if (transcriptUnchanged) return
        lastTranscriptLength = snapshot.transcript.length
        fold = nextFold
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
    /** 重建 markdown 样式（颜色在创建时烘焙进 OpenTUI 对象）并全量重放历史。 */
    refreshTheme() {
      return queueOperation(async () => {
        // 先创建新样式再销毁旧样式：即使重放失败也保持可用状态。
        const nextStyles = createAssistantMarkdownStyles()
        assistantMarkdownStyles.markdown.destroy()
        assistantMarkdownStyles.code.destroy()
        assistantMarkdownStyles = nextStyles
        await syncHistory(true)
      })
    },
  }
}
