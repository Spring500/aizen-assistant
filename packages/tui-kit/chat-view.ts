import { BoxRenderable, type CliRenderer, CliRenderEvents, type RenderContext, TextRenderable } from "@opentui/core"
import type { FoldPreferences } from "../core/app-preferences-store.ts"
import type { Timing, ToolCallPart, ToolMessage } from "../core/session-format.ts"
import type { CoreSnapshot } from "../core/types.ts"
import { systemColors } from "./theme.ts"

export type ChatView = {
  header: TextRenderable
  live: TextRenderable
  status: TextRenderable
  destroy(): void
  update(snapshot: CoreSnapshot): void
  getFoldPreferences(): FoldPreferences
  setFoldPreferences(fold: FoldPreferences): void
}

type ToolDisplay = {
  id: string
  call: string
  result: string
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
  tool: "#34373d",
  toolGroup: "#292c31",
} as const

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

function toolCallText(name: string, argumentsValue: unknown): string {
  const argumentsObject = objectValue(argumentsValue)
  if (name === "bash" && typeof argumentsObject?.command === "string") {
    const timeout = typeof argumentsObject.timeout === "number" ? `（超时 ${argumentsObject.timeout} 秒）` : ""
    return `[bash] ${oneLine(argumentsObject.command)}${timeout}`
  }
  if (name === "read" && typeof argumentsObject?.path === "string") {
    const options = [
      typeof argumentsObject.offset === "number" ? `第 ${argumentsObject.offset} 行起` : "",
      typeof argumentsObject.limit === "number" ? `最多 ${argumentsObject.limit} 行` : "",
    ].filter(Boolean)
    return `[read] ${oneLine(argumentsObject.path)}${options.length > 0 ? `（${options.join("，")}）` : ""}`
  }
  if (name === "edit" && typeof argumentsObject?.path === "string") {
    const editCount = Array.isArray(argumentsObject.edits) ? argumentsObject.edits.length : 0
    return `[edit] ${oneLine(argumentsObject.path)}（${editCount} 处修改）`
  }
  if (name === "write" && typeof argumentsObject?.path === "string") {
    const contentLength = typeof argumentsObject.content === "string" ? argumentsObject.content.length : 0
    return `[write] ${oneLine(argumentsObject.path)}（写入 ${contentLength} 字符）`
  }
  return `[${name}] ${jsonPreview(argumentsValue)}`
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
  return `[工具结果:${message.name}] ${outputPreview(text)}`
}

function toolDisplay(call: ToolCallPart, result: ToolMessage | undefined): ToolDisplay {
  const callText = toolCallText(call.name, call.arguments)
  return {
    id: call.callId,
    call: call.declaredIntent ? `${callText}\n声明目的：${call.declaredIntent}` : callText,
    result: result ? toolMessageText(result) : `[等待结果:${call.name}]`,
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
  const results = new Map<string, ToolMessage>()
  const calls = new Set<string>()
  for (const entry of snapshot.transcript) {
    if (entry.type !== "message") continue
    if (entry.message.role === "tool") results.set(entry.message.callId, entry.message)
    else for (const part of entry.message.parts) if (part.kind === "tool_call") calls.add(part.callId)
  }

  const blocks: DisplayBlock[] = []
  for (const [entryIndex, entry] of snapshot.transcript.entries()) {
    if (entry.type === "input") {
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
          call: `[未知工具调用:${entry.message.name}]`,
          result: toolMessageText(entry.message),
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

function makeText(context: RenderContext, id: string, content: string, color: string): TextRenderable {
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

function expanded(limit: number, turnAge: number): boolean {
  return limit === 0 || turnAge < limit
}

function createHistoryBlock(
  context: RenderContext,
  index: number,
  block: DisplayBlock,
  fold: FoldPreferences,
  turnAge: number,
): BoxRenderable {
  const rootId = `history-entry-${index}`
  if (block.kind === "plain") {
    const root = makeBox(context, rootId, blockColors.plain)
    root.add(makeText(context, `${rootId}-text`, block.content, blockColors.plain))
    return root
  }
  if (block.kind === "user") {
    const root = makeBox(context, rootId, blockColors.user)
    const content = expanded(fold.userTurns, turnAge) ? block.content : `▶ 你 ${oneLine(block.content).slice(4, 84)}...`
    root.add(makeText(context, `${rootId}-text`, content, blockColors.user))
    return root
  }
  if (block.kind === "assistant" || block.kind === "thinking") {
    const isThinking = block.kind === "thinking"
    const color = isThinking ? blockColors.thinking : blockColors.assistant
    const isExpanded = expanded(isThinking ? fold.thinkingTurns : fold.assistantTurns, turnAge)
    const label = isThinking ? "思考" : "助手"
    const meta = timingText(block.timing)
    const content = isExpanded
      ? `▼ ${label}${meta ? `  ${meta}` : ""}\n${block.content}`
      : `▶ ${label} ${oneLine(block.content).slice(0, 80)}...${meta ? `  ${meta}` : ""}`
    const root = makeBox(context, rootId, color)
    root.add(makeText(context, `${rootId}-text`, content, color))
    return root
  }

  const root = makeBox(context, rootId, blockColors.toolGroup)
  const groupExpanded = expanded(fold.toolGroupTurns, turnAge)
  const detailsExpanded = groupExpanded && expanded(fold.toolDetailTurns, turnAge)
  const names = block.tools.map((tool) => tool.call.match(/^\[([^\]]+)]/)?.[1] ?? "工具").join("、")
  const meta = timingText(block.timing)
  root.add(
    makeText(
      context,
      `${rootId}-header`,
      `${groupExpanded ? "▼" : "▶"} ${block.tools.length} 个工具调用：${names}${meta ? `  ${meta}` : ""}`,
      blockColors.toolGroup,
    ),
  )
  if (groupExpanded) {
    const content = new BoxRenderable(context, {
      id: `${rootId}-content`,
      width: "100%",
      height: "auto",
      flexDirection: "column",
      paddingTop: 1,
      backgroundColor: blockColors.toolGroup,
    })
    for (const [toolIndex, tool] of block.tools.entries()) {
      const toolRoot = makeBox(
        context,
        `${rootId}-tool-${toolIndex}`,
        blockColors.tool,
        toolIndex === block.tools.length - 1 ? 0 : 1,
      )
      const metaText = timingText(tool.timing)
      const callLines = tool.call.split("\n")
      const visibleCall = callLines.slice(0, callLines[1]?.startsWith("声明目的：") ? 2 : 1).join("\n")
      const text = detailsExpanded
        ? `${tool.call}${metaText ? `  ${metaText}` : ""}\n${tool.result}`
        : `${visibleCall}${metaText ? `  ${metaText}` : ""}`
      toolRoot.add(makeText(context, `${rootId}-tool-${toolIndex}-text`, text, blockColors.tool))
      content.add(toolRoot)
    }
    root.add(content)
  }
  return root
}

function liveText(snapshot: CoreSnapshot): string {
  const metrics = snapshot.responseMetrics
  const metricText = metrics
    ? ` | 耗时 ${formatDurationText(metrics.elapsedSeconds * 1000)} · 生成 ${metrics.outputTokens} tokens`
    : ""
  const active = snapshot.activeTools.at(-1)
  if (active) {
    const output = active.outputPreview ? outputPreview(active.outputPreview) : "等待输出"
    return `${toolCallText(active.name, active.arguments)} | ${active.isFinished ? "完成" : "运行中"}：${output}${metricText}`
  }
  if (snapshot.streamingText) return `[助手流式] ${outputPreview(snapshot.streamingText)}${metricText}`
  if (snapshot.streamingThinking) return `[思考流式] ${outputPreview(snapshot.streamingThinking)}${metricText}`
  return metrics ? `助手回复中${metricText}` : ""
}

function statusText(snapshot: CoreSnapshot): string {
  if (snapshot.lastError) return `错误：${snapshot.lastError}`
  return {
    idle: "空闲",
    running: "处理中",
    aborting: "正在中止",
    authenticating: "等待输入认证信息",
    error: "发生错误",
  }[snapshot.status]
}

export function createChatView(renderer: CliRenderer): ChatView {
  const header = new TextRenderable(renderer, {
    id: "header",
    height: 1,
    fg: systemColors.header,
    content: "AizenAssistant",
  })
  const live = new TextRenderable(renderer, {
    id: "live",
    width: "100%",
    height: 1,
    wrapMode: "none",
    truncate: true,
    fg: systemColors.live,
    content: "",
  })
  const status = new TextRenderable(renderer, { id: "status", height: 1, fg: systemColors.statusIdle, content: "空闲" })
  renderer.root.add(header)
  renderer.root.add(live)
  renderer.root.add(status)

  let blocks: DisplayBlock[] = []
  let fold: FoldPreferences = {
    userTurns: 0,
    assistantTurns: 3,
    thinkingTurns: 1,
    toolGroupTurns: 1,
    toolDetailTurns: 1,
  }
  let committedFingerprints: string[] = []
  let latestSnapshot: CoreSnapshot | undefined
  let notice = ""
  let resizeTimer: ReturnType<typeof setTimeout> | undefined

  const turnAges = () => {
    const ids = [...new Set(blocks.map((block) => block.turnId))]
    return new Map(ids.map((id, index) => [id, ids.length - index - 1]))
  }

  const renderedFingerprints = () => blocks.map((block) => JSON.stringify({ block, fold }))

  const commitBlocks = (startIndex: number) => {
    if (startIndex >= blocks.length) return
    const ages = turnAges()
    const surface = renderer.createScrollbackSurface()
    try {
      for (let index = startIndex; index < blocks.length; index += 1) {
        const block = blocks[index] as DisplayBlock
        surface.root.add(createHistoryBlock(surface.renderContext, index, block, fold, ages.get(block.turnId) ?? 0))
      }
      surface.render()
      surface.commitRows(0, surface.height)
    } finally {
      surface.destroy()
    }
  }

  const syncHistory = (forceReplay = false) => {
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
    if (canAppend) commitBlocks(committedFingerprints.length)
    else {
      try {
        renderer.resetSplitFooterForReplay({ clearSavedLines: true })
      } catch (error) {
        // OpenTUI 的离屏测试渲染器没有活动终端，无法执行 ANSI 清屏；仍继续提交回放快照。
        if (!(error instanceof Error) || error.message !== "resetSplitFooterForReplay requires an active terminal")
          throw error
      }
      commitBlocks(0)
    }
    committedFingerprints = nextFingerprints
  }

  const refreshFooter = () => {
    if (!latestSnapshot) return
    header.content = "AizenAssistant | /fold 折叠设置"
    live.content = liveText(latestSnapshot)
    status.content = notice || statusText(latestSnapshot)
    status.fg =
      latestSnapshot.lastError || latestSnapshot.status === "error"
        ? systemColors.statusError
        : latestSnapshot.status === "idle"
          ? systemColors.statusIdle
          : systemColors.statusRunning
  }

  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined
      if (!latestSnapshot) return
      syncHistory(true)
      refreshFooter()
    }, 75)
  }
  renderer.on(CliRenderEvents.RESIZE, onResize)

  return {
    header,
    live,
    status,
    destroy() {
      if (resizeTimer) clearTimeout(resizeTimer)
      renderer.off(CliRenderEvents.RESIZE, onResize)
      header.destroy()
      live.destroy()
      status.destroy()
    },
    update(snapshot) {
      latestSnapshot = snapshot
      notice = ""
      fold = { ...snapshot.preferences.fold }
      blocks = displayBlocks(snapshot)
      syncHistory()
      refreshFooter()
    },
    getFoldPreferences() {
      return { ...fold }
    },
    setFoldPreferences(next) {
      fold = { ...next }
      notice = "已应用折叠设置，并全量回放会话"
      syncHistory(true)
      refreshFooter()
    },
  }
}
