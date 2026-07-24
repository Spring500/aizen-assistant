import { BoxRenderable, type CliRenderer, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import type { ToolCallPart, ToolMessage } from "../core/session-format.ts"
import type { CoreSnapshot } from "../core/types.ts"

export type ChatView = {
  header: TextRenderable
  scrollBox: ScrollBoxRenderable
  status: TextRenderable
  update(snapshot: CoreSnapshot): void
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

type RenderedBlock = {
  kind: DisplayBlock["kind"]
  id: string
  fingerprint: string
  root: TextRenderable | BoxRenderable
}

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
  return `▶ 助手（点击展开） ${oneLine(content).slice(0, 80)}...`
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

function toolDisplay(
  call: ToolCallPart,
  result: ToolMessage | undefined,
  active: CoreSnapshot["activeTools"][number] | undefined,
): ToolDisplay {
  let resultText = `[等待结果:${call.name}]`
  if (result) resultText = toolMessageText(result)
  else if (active) {
    const preview = outputPreview(active.outputPreview ?? "")
    resultText = active.isFinished
      ? `[工具结果:${call.name}] ${preview}`
      : `[运行中] ${active.outputPreview ? preview : "等待输出"}`
  }
  return {
    id: call.callId,
    call: toolCallText(call.name, call.arguments),
    result: resultText,
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
    if (tools.length === 1) grouped.push({ kind: "tool", id: tools[0]?.id ?? "tool", tool: tools[0] as ToolDisplay })
    else grouped.push({ kind: "tool_group", id: `tools-${tools.map((tool) => tool.id).join("-")}`, tools })
  }
  return grouped
}

function displayBlocks(snapshot: CoreSnapshot): DisplayBlock[] {
  const results = new Map<string, ToolMessage>()
  const calls = new Set<string>()
  for (const entry of snapshot.transcript) {
    if (entry.type !== "message") continue
    if (entry.message.role === "tool") results.set(entry.message.callId, entry.message)
    else {
      for (const part of entry.message.parts) if (part.kind === "tool_call") calls.add(part.callId)
    }
  }
  const activeTools = new Map(snapshot.activeTools.map((tool) => [tool.callId, tool]))
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
              tool: toolDisplay(part, results.get(part.callId), activeTools.get(part.callId)),
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
  for (const tool of snapshot.activeTools) {
    if (calls.has(tool.callId)) continue
    const call: ToolCallPart = {
      kind: "tool_call",
      callId: tool.callId,
      name: tool.name,
      arguments: tool.arguments as ToolCallPart["arguments"],
    }
    blocks.push({ kind: "tool", id: tool.callId, tool: toolDisplay(call, undefined, tool) })
  }
  return groupConsecutiveTools(blocks)
}

function fingerprint(block: DisplayBlock): string {
  return JSON.stringify(block)
}

function makeBox(renderer: CliRenderer, id: string, color: string, marginBottom = 1): BoxRenderable {
  return new BoxRenderable(renderer, {
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

function makeText(renderer: CliRenderer, id: string, content: string, color?: string): TextRenderable {
  return new TextRenderable(renderer, {
    id,
    width: "100%",
    height: "auto",
    wrapMode: color === blockColors.tool ? "none" : "word",
    truncate: color === blockColors.tool,
    ...(color ? { bg: color } : {}),
    content,
  })
}

function installToggle(root: BoxRenderable, toggle: () => void): void {
  root.onMouseDown = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    toggle()
  }
}

function createToolBox(renderer: CliRenderer, id: string, tool: ToolDisplay, marginBottom = 1): BoxRenderable {
  const root = makeBox(renderer, id, blockColors.tool, marginBottom)
  root.add(makeText(renderer, `${id}-text`, `${tool.call}\n${tool.result}`, blockColors.tool))
  return root
}

function createAssistantBox(
  renderer: CliRenderer,
  id: string,
  stateId: string,
  content: string,
  collapsedState: Map<string, boolean>,
): BoxRenderable {
  const root = makeBox(renderer, id, blockColors.assistant)
  const text = makeText(renderer, `${id}-text`, "", blockColors.assistant)
  root.add(text)
  const render = () => {
    const collapsed = collapsedState.get(stateId) ?? false
    text.content = collapsed ? collapsedAssistantText(content) : `▼ 助手（点击折叠）\n${content}`
  }
  installToggle(root, () => {
    collapsedState.set(stateId, !(collapsedState.get(stateId) ?? false))
    render()
  })
  render()
  return root
}

function createToolGroup(
  renderer: CliRenderer,
  id: string,
  stateId: string,
  tools: ToolDisplay[],
  collapsedState: Map<string, boolean>,
): BoxRenderable {
  const root = makeBox(renderer, id, blockColors.toolGroup)
  const header = makeText(renderer, `${id}-header`, "", blockColors.toolGroup)
  const content = new BoxRenderable(renderer, {
    id: `${id}-content`,
    width: "100%",
    height: "auto",
    flexDirection: "column",
    paddingTop: 1,
    backgroundColor: blockColors.toolGroup,
  })
  for (const [index, tool] of tools.entries()) {
    content.add(createToolBox(renderer, `${id}-tool-${index}`, tool, index === tools.length - 1 ? 0 : 1))
  }
  root.add(header)
  root.add(content)
  if (!collapsedState.has(stateId)) collapsedState.set(stateId, true)
  const names = tools.map((tool) => tool.call.match(/^\[([^\]]+)]/)?.[1] ?? "工具").join("、")
  const render = () => {
    const collapsed = collapsedState.get(stateId) ?? true
    header.content = `${collapsed ? "▶" : "▼"} ${tools.length} 个工具调用：${names}（点击${collapsed ? "展开" : "折叠"}）`
    content.visible = !collapsed
  }
  installToggle(root, () => {
    collapsedState.set(stateId, !(collapsedState.get(stateId) ?? true))
    render()
  })
  render()
  return root
}

function createBlock(
  renderer: CliRenderer,
  index: number,
  block: DisplayBlock,
  collapsedState: Map<string, boolean>,
): RenderedBlock {
  const rootId = `transcript-entry-${index}`
  let root: TextRenderable | BoxRenderable
  if (block.kind === "plain") {
    root = new TextRenderable(renderer, {
      id: rootId,
      width: "100%",
      height: "auto",
      marginBottom: 1,
      content: block.content,
    })
  } else if (block.kind === "user") {
    root = makeBox(renderer, rootId, blockColors.user)
    root.add(makeText(renderer, `${rootId}-text`, block.content, blockColors.user))
  } else if (block.kind === "assistant") {
    root = createAssistantBox(renderer, rootId, block.id, block.content, collapsedState)
  } else if (block.kind === "tool") {
    root = createToolBox(renderer, rootId, block.tool)
  } else {
    root = createToolGroup(renderer, rootId, block.id, block.tools, collapsedState)
  }
  return { kind: block.kind, id: block.id, fingerprint: fingerprint(block), root }
}

function updateBlocks(
  renderer: CliRenderer,
  scrollBox: ScrollBoxRenderable,
  renderedBlocks: RenderedBlock[],
  blocks: DisplayBlock[],
  collapsedState: Map<string, boolean>,
): void {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as DisplayBlock
    const previous = renderedBlocks[index]
    const nextFingerprint = fingerprint(block)
    if (previous && previous.kind === block.kind && previous.id === block.id) {
      if (previous.fingerprint === nextFingerprint) continue
      if (block.kind === "tool") {
        const text = previous.root.getRenderable(`${previous.root.id}-text`)
        if (text instanceof TextRenderable) text.content = `${block.tool.call}\n${block.tool.result}`
        previous.fingerprint = nextFingerprint
        continue
      }
      if (block.kind === "tool_group") {
        for (const [toolIndex, tool] of block.tools.entries()) {
          const text = previous.root.getRenderable(`${previous.root.id}-tool-${toolIndex}-text`)
          if (text instanceof TextRenderable) text.content = `${tool.call}\n${tool.result}`
        }
        previous.fingerprint = nextFingerprint
        continue
      }
    }
    previous?.root.destroyRecursively()
    const rendered = createBlock(renderer, index, block, collapsedState)
    renderedBlocks[index] = rendered
    scrollBox.add(rendered.root, index)
  }
  while (renderedBlocks.length > blocks.length) renderedBlocks.pop()?.root.destroyRecursively()
}

export function createChatView(renderer: CliRenderer): ChatView {
  const header = new TextRenderable(renderer, { id: "header", height: 1, content: "AizenAssistant" })
  const scrollBox = new ScrollBoxRenderable(renderer, {
    id: "transcript-scroll",
    flexGrow: 1,
    scrollY: true,
    contentOptions: { flexDirection: "column" },
  })
  const renderedBlocks: RenderedBlock[] = []
  const collapsedState = new Map<string, boolean>()
  let streamingContent = ""
  const streaming = makeBox(renderer, "transcript-streaming", blockColors.assistant)
  const streamingText = makeText(renderer, "transcript-streaming-text", "", blockColors.assistant)
  const renderStreaming = () => {
    const collapsed = collapsedState.get("transcript-streaming") ?? false
    streamingText.content = collapsed
      ? collapsedAssistantText(streamingContent)
      : `▼ 助手（点击折叠）\n${streamingContent}`
  }
  streaming.add(streamingText)
  installToggle(streaming, () => {
    collapsedState.set("transcript-streaming", !(collapsedState.get("transcript-streaming") ?? false))
    renderStreaming()
  })
  streaming.visible = false
  scrollBox.add(streaming)
  const status = new TextRenderable(renderer, { id: "status", height: 1, content: "空闲" })
  renderer.root.add(header)
  renderer.root.add(scrollBox)
  renderer.root.add(status)

  return {
    header,
    scrollBox,
    status,
    update(snapshot) {
      const model = snapshot.currentModel
        ? `${snapshot.currentModel.providerId}/${snapshot.currentModel.modelId}`
        : "未选择模型"
      header.content = `AizenAssistant | ${snapshot.cwd} | ${model}`
      updateBlocks(renderer, scrollBox, renderedBlocks, displayBlocks(snapshot), collapsedState)
      streamingContent = [
        snapshot.streamingThinking ? `[思考] ${snapshot.streamingThinking}` : "",
        snapshot.streamingText,
      ]
        .filter(Boolean)
        .join("\n")
      renderStreaming()
      streaming.visible = streamingContent.length > 0
      const tools = snapshot.activeTools.map((tool) => `${tool.name}${tool.isError ? "（失败）" : ""}`).join("、")
      status.content = snapshot.lastError
        ? `错误：${snapshot.lastError}`
        : tools
          ? `工具：${tools}`
          : {
              idle: "空闲",
              running: "处理中",
              aborting: "正在中止",
              authenticating: "等待输入认证信息",
              error: "发生错误",
            }[snapshot.status]
    },
  }
}
