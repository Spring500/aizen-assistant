import { BoxRenderable, type CliRenderer, type RenderContext, TextRenderable } from "@opentui/core"
import type { ToolCallPart, ToolMessage } from "../core/session-format.ts"
import type { CoreSnapshot } from "../core/types.ts"
import { systemTextColor } from "./theme.ts"

export type ChatView = {
  header: TextRenderable
  live: TextRenderable
  status: TextRenderable
  update(snapshot: CoreSnapshot): void
  getCollapseItems(): ChatCollapseItem[]
  toggleCollapse(id: string): boolean
  collapseAll(collapsed: boolean, kind?: ChatCollapseItem["kind"]): boolean
}

export type ChatCollapseItem = {
  id: string
  kind: "assistant" | "tool_group"
  name: string
  description: string
  collapsed: boolean
}

type ToolDisplay = {
  id: string
  call: string
  result: string
}

type DisplayBlock =
  | { kind: "plain"; id: string; content: string }
  | { kind: "user"; id: string; content: string }
  | { kind: "assistant"; id: string; content: string }
  | { kind: "tool"; id: string; tool: ToolDisplay }
  | { kind: "tool_group"; id: string; tools: ToolDisplay[] }

type CollapseTarget = Omit<ChatCollapseItem, "collapsed">

const blockColors = {
  user: "#66551a",
  assistant: "#1f2937",
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

function collapsedAssistantText(content: string): string {
  return `▶ 助手 ${oneLine(content).slice(0, 80)}...`
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
  return {
    id: call.callId,
    call: toolCallText(call.name, call.arguments),
    result: result ? toolMessageText(result) : `[等待结果:${call.name}]`,
  }
}

function groupConsecutiveTools(blocks: DisplayBlock[]): DisplayBlock[] {
  const grouped: DisplayBlock[] = []
  for (let index = 0; index < blocks.length; ) {
    const block = blocks[index] as DisplayBlock
    if (block.kind !== "tool") {
      grouped.push(block)
      index += 1
      continue
    }
    const tools: ToolDisplay[] = []
    while (index < blocks.length) {
      const next = blocks[index] as DisplayBlock
      if (next.kind !== "tool") break
      tools.push(next.tool)
      index += 1
    }
    if (tools.length === 1)
      grouped.push({
        kind: "tool",
        id: tools[0]?.id ?? "tool",
        tool: tools[0] as ToolDisplay,
      })
    else
      grouped.push({
        kind: "tool_group",
        id: `tools-${tools.map((tool) => tool.id).join("-")}`,
        tools,
      })
  }
  return grouped
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
          content: item.source === "user" ? `[你] ${text}` : `[额外消息:${item.source}] ${text}`,
        })
      }
    } else if (entry.type === "message") {
      if (entry.message.role === "assistant") {
        for (const [partIndex, part] of entry.message.parts.entries()) {
          if (part.kind === "text") {
            blocks.push({
              kind: "assistant",
              id: `assistant-${entry.turnId}-${entryIndex}-${partIndex}`,
              content: part.text,
            })
          }
          if (part.kind === "thinking") {
            blocks.push({
              kind: "plain",
              id: `thinking-${entry.turnId}-${entryIndex}-${partIndex}`,
              content: `[思考] ${part.text}`,
            })
          }
          if (part.kind === "tool_call") {
            blocks.push({
              kind: "tool",
              id: part.callId,
              tool: toolDisplay(part, results.get(part.callId)),
            })
          }
        }
      } else if (!calls.has(entry.message.callId)) {
        blocks.push({
          kind: "tool",
          id: entry.message.callId,
          tool: {
            id: entry.message.callId,
            call: `[未知工具调用:${entry.message.name}]`,
            result: toolMessageText(entry.message),
          },
        })
      }
    } else if (entry.outcome !== "completed") {
      blocks.push({
        kind: "plain",
        id: `outcome-${entry.turnId}`,
        content: entry.outcome === "aborted" ? "[已中止]" : "[执行失败]",
      })
    }
  }
  return groupConsecutiveTools(blocks)
}

function collapseTargets(blocks: DisplayBlock[]): CollapseTarget[] {
  const targets: CollapseTarget[] = []
  for (const block of blocks) {
    if (block.kind !== "assistant" && block.kind !== "tool_group") continue
    if (block.kind === "assistant") {
      targets.push({
        id: block.id,
        kind: block.kind,
        name: "助手",
        description: oneLine(block.content).slice(0, 80),
      })
      continue
    }
    const names = block.tools.map((tool) => tool.call.match(/^\[([^\]]+)]/)?.[1] ?? "工具")
    targets.push({
      id: block.id,
      kind: block.kind,
      name: `工具：${names.join("、")}`,
      description: `${block.tools.length} 个连续工具调用`,
    })
  }
  return targets
}

function makeBox(context: RenderContext, id: string, color: string, marginBottom = 1): BoxRenderable {
  return new BoxRenderable(context, {
    id,
    width: "100%",
    height: "auto",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    marginBottom,
    backgroundColor: color,
  })
}

function makeText(context: RenderContext, id: string, content: string, color?: string): TextRenderable {
  return new TextRenderable(context, {
    id,
    width: color && color !== blockColors.tool ? "auto" : "100%",
    height: "auto",
    wrapMode: color === blockColors.tool ? "none" : "word",
    truncate: color === blockColors.tool,
    ...(color ? { bg: color } : {}),
    content,
  })
}

function createToolBox(context: RenderContext, id: string, tool: ToolDisplay, marginBottom = 1): BoxRenderable {
  const root = makeBox(context, id, blockColors.tool, marginBottom)
  root.add(makeText(context, `${id}-text`, `${tool.call}\n${tool.result}`, blockColors.tool))
  return root
}

function createHistoryBlock(
  context: RenderContext,
  index: number,
  block: DisplayBlock,
  collapsedState: Map<string, boolean>,
): TextRenderable | BoxRenderable {
  const rootId = `history-entry-${index}`
  if (block.kind === "plain") {
    return new TextRenderable(context, {
      id: rootId,
      width: "100%",
      height: "auto",
      marginBottom: 1,
      fg: systemTextColor,
      content: block.content,
    })
  }
  if (block.kind === "user") {
    const root = makeBox(context, rootId, blockColors.user)
    root.add(makeText(context, `${rootId}-text`, block.content, blockColors.user))
    return root
  }
  if (block.kind === "assistant") {
    const root = makeBox(context, rootId, blockColors.assistant)
    const content = collapsedState.get(block.id) ? collapsedAssistantText(block.content) : `▼ 助手\n${block.content}`
    root.add(makeText(context, `${rootId}-text`, content, blockColors.assistant))
    return root
  }
  if (block.kind === "tool") return createToolBox(context, rootId, block.tool)

  const root = makeBox(context, rootId, blockColors.toolGroup)
  const names = block.tools.map((tool) => tool.call.match(/^\[([^\]]+)]/)?.[1] ?? "工具").join("、")
  const collapsed = collapsedState.get(block.id) ?? true
  root.add(
    makeText(
      context,
      `${rootId}-header`,
      `${collapsed ? "▶" : "▼"} ${block.tools.length} 个工具调用：${names}`,
      blockColors.toolGroup,
    ),
  )
  if (!collapsed) {
    const content = new BoxRenderable(context, {
      id: `${rootId}-content`,
      width: "100%",
      height: "auto",
      flexDirection: "column",
      paddingTop: 1,
      backgroundColor: blockColors.toolGroup,
    })
    for (const [toolIndex, tool] of block.tools.entries()) {
      content.add(
        createToolBox(context, `${rootId}-tool-${toolIndex}`, tool, toolIndex === block.tools.length - 1 ? 0 : 1),
      )
    }
    root.add(content)
  }
  return root
}

function liveText(snapshot: CoreSnapshot): string {
  const metrics = snapshot.responseMetrics
  const metricText = metrics ? ` | ${metrics.elapsedSeconds}s · ${metrics.outputTokens} tokens` : ""
  const active = snapshot.activeTools.at(-1)
  if (active) {
    const output = active.outputPreview ? outputPreview(active.outputPreview) : "等待输出"
    return `${toolCallText(active.name, active.arguments)} | ${active.isFinished ? "完成" : "运行中"}：${output}${metricText}`
  }
  if (snapshot.streamingText) return `[助手流式] ${outputPreview(snapshot.streamingText)}${metricText}`
  if (snapshot.streamingThinking) return `[思考流式] ${outputPreview(snapshot.streamingThinking)}${metricText}`
  return metrics ? `助手回复中${metricText}` : ""
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US")
}

function contextText(snapshot: CoreSnapshot): string {
  const used = snapshot.contextUsage?.used ?? 0
  const total = snapshot.contextUsage?.total
  return total ? `${formatNumber(used)}/${formatNumber(total)}` : `${formatNumber(used)}/未知`
}

export function sessionStatusText(snapshot: CoreSnapshot): string {
  const model = snapshot.currentModel
    ? `${snapshot.currentModel.providerId}/${snapshot.currentModel.modelId}`
    : "未选择模型"
  return `模型：${model} | 上下文：${contextText(snapshot)}`
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
    fg: systemTextColor,
    content: "AizenAssistant",
  })
  const live = new TextRenderable(renderer, {
    id: "live",
    width: "100%",
    height: 1,
    wrapMode: "none",
    truncate: true,
    fg: systemTextColor,
    content: "",
  })
  const status = new TextRenderable(renderer, {
    id: "status",
    height: 1,
    fg: systemTextColor,
    content: "空闲",
  })
  renderer.root.add(header)
  renderer.root.add(live)
  renderer.root.add(status)

  const collapsedState = new Map<string, boolean>()
  let blocks: DisplayBlock[] = []
  let targets: CollapseTarget[] = []
  let committedFingerprints: string[] = []
  let latestSnapshot: CoreSnapshot | undefined
  let notice = ""

  const prepareCollapseState = () => {
    targets = collapseTargets(blocks)
    for (const target of targets) {
      if (!collapsedState.has(target.id)) collapsedState.set(target.id, target.kind === "tool_group")
    }
  }

  const renderedFingerprints = () => {
    return blocks.map((block) =>
      JSON.stringify({
        block,
        collapsed: collapsedState.get(block.id),
      }),
    )
  }

  const commitBlocks = (startIndex: number) => {
    if (startIndex >= blocks.length) return
    const surface = renderer.createScrollbackSurface()
    try {
      for (let index = startIndex; index < blocks.length; index += 1) {
        surface.root.add(
          createHistoryBlock(surface.renderContext, index, blocks[index] as DisplayBlock, collapsedState),
        )
      }
      surface.render()
      surface.commitRows(0, surface.height)
    } finally {
      surface.destroy()
    }
  }

  const syncHistory = (forceReplay = false) => {
    prepareCollapseState()
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
        // OpenTUI 的离屏测试渲染器没有活动终端，无法执行 ANSI 清屏；仍继续提交回放快照以验证内容。
        if (!(error instanceof Error) || error.message !== "resetSplitFooterForReplay requires an active terminal")
          throw error
      }
      commitBlocks(0)
    }
    committedFingerprints = nextFingerprints
  }

  const refreshFooter = () => {
    if (!latestSnapshot) return
    const snapshot = latestSnapshot
    header.content = `AizenAssistant | /fold 管理折叠`
    live.content = liveText(snapshot)
    status.content = notice || statusText(snapshot)
  }

  const toggleCollapse = (id: string): boolean => {
    const target = targets.find((item) => item.id === id)
    if (!target) {
      notice = "找不到要切换的折叠内容"
      refreshFooter()
      return false
    }
    collapsedState.set(target.id, !(collapsedState.get(target.id) ?? false))
    notice = `已切换${target.name}，并全量回放会话`
    syncHistory(true)
    refreshFooter()
    return true
  }

  const collapseAll = (collapsed: boolean, kind?: ChatCollapseItem["kind"]): boolean => {
    let changed = false
    for (const target of targets) {
      if (kind && target.kind !== kind) continue
      if ((collapsedState.get(target.id) ?? false) === collapsed) continue
      collapsedState.set(target.id, collapsed)
      changed = true
    }
    notice = changed ? `已${collapsed ? "折叠" : "展开"}所选内容，并全量回放会话` : "折叠状态没有变化"
    if (changed) syncHistory(true)
    refreshFooter()
    return changed
  }

  return {
    header,
    live,
    status,
    update(snapshot) {
      latestSnapshot = snapshot
      notice = ""
      blocks = displayBlocks(snapshot)
      syncHistory()
      refreshFooter()
    },
    getCollapseItems() {
      return targets.map((target) => ({
        ...target,
        collapsed: collapsedState.get(target.id) ?? false,
      }))
    },
    toggleCollapse,
    collapseAll,
  }
}
