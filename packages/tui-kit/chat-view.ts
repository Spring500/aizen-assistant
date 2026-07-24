import { BoxRenderable, type CliRenderer, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import type { CoreSnapshot, TranscriptEntry } from "../core/types.ts"

export type ChatView = {
  header: TextRenderable
  scrollBox: ScrollBoxRenderable
  status: TextRenderable
  update(snapshot: CoreSnapshot): void
}

type BlockStyle = "plain" | "user" | "tool"
type DisplayBlock = { style: BlockStyle; content: string }
type RenderedBlock = {
  style: BlockStyle
  content: string
  root: TextRenderable | BoxRenderable
  text: TextRenderable
}

const blockColors = {
  user: "#66551a",
  tool: "#34373d",
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

function lastOutputLine(text: string): { lastLine: string; omitted: boolean } {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "")
  if (!normalized) return { lastLine: "", omitted: false }
  const lines = normalized.split("\n")
  return { lastLine: lines.at(-1) ?? "", omitted: lines.length > 1 }
}

function toolResultText(name: string, text: string): string {
  const result = lastOutputLine(text)
  return `[工具结果:${name}] ${result.omitted ? "..." : ""}${result.lastLine}`
}

function entryBlocks(entry: TranscriptEntry): DisplayBlock[] {
  const blocks: DisplayBlock[] = []
  if (entry.type === "input") {
    for (const item of entry.items) {
      const text = item.parts
        .filter((part) => part.kind === "text")
        .map((part) => part.text)
        .join("\n")
      blocks.push({
        style: item.source === "user" ? "user" : "plain",
        content: item.source === "user" ? `[你] ${text}` : `[额外消息:${item.source}] ${text}`,
      })
    }
  } else if (entry.type === "message") {
    if (entry.message.role === "assistant") {
      for (const part of entry.message.parts) {
        if (part.kind === "text") blocks.push({ style: "plain", content: `[助手] ${part.text}` })
        if (part.kind === "thinking") blocks.push({ style: "plain", content: `[思考] ${part.text}` })
        if (part.kind === "tool_call") blocks.push({ style: "tool", content: toolCallText(part.name, part.arguments) })
      }
    } else {
      const text = entry.message.parts
        .filter((part) => part.kind === "text")
        .map((part) => part.text)
        .join("\n")
      blocks.push({ style: "tool", content: toolResultText(entry.message.name, text) })
    }
  } else if (entry.outcome !== "completed") {
    blocks.push({ style: "plain", content: entry.outcome === "aborted" ? "[已中止]" : "[执行失败]" })
  }
  return blocks
}

function activeToolBlocks(snapshot: CoreSnapshot): DisplayBlock[] {
  const historicalCallIds = new Set<string>()
  const historicalResultIds = new Set<string>()
  for (const entry of snapshot.transcript) {
    if (entry.type !== "message") continue
    if (entry.message.role === "tool") historicalResultIds.add(entry.message.callId)
    else
      for (const part of entry.message.parts) {
        if (part.kind === "tool_call") historicalCallIds.add(part.callId)
      }
  }

  const blocks: DisplayBlock[] = []
  for (const tool of snapshot.activeTools) {
    if (!historicalCallIds.has(tool.callId))
      blocks.push({ style: "tool", content: toolCallText(tool.name, tool.arguments) })
    if (!tool.isFinished && !historicalResultIds.has(tool.callId)) {
      const result = lastOutputLine(tool.outputPreview ?? "")
      const preview = result.lastLine ? `${result.omitted ? "..." : ""}${result.lastLine}` : "等待输出"
      blocks.push({ style: "tool", content: `[运行中] ${preview}` })
    }
  }
  return blocks
}

function displayBlocks(snapshot: CoreSnapshot): DisplayBlock[] {
  return [...snapshot.transcript.flatMap(entryBlocks), ...activeToolBlocks(snapshot)]
}

function streamingText(snapshot: CoreSnapshot): string {
  const lines: string[] = []
  if (snapshot.streamingThinking) lines.push(`[思考] ${snapshot.streamingThinking}`)
  if (snapshot.streamingText) lines.push(`[助手] ${snapshot.streamingText}`)
  return lines.join("\n")
}

function createBlock(renderer: CliRenderer, index: number, block: DisplayBlock): RenderedBlock {
  if (block.style === "plain") {
    const text = new TextRenderable(renderer, {
      id: `transcript-entry-${index}`,
      width: "100%",
      height: "auto",
      marginBottom: 1,
      content: block.content,
    })
    return { ...block, root: text, text }
  }

  const root = new BoxRenderable(renderer, {
    id: `transcript-entry-${index}`,
    width: "100%",
    height: "auto",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    marginBottom: block.style === "tool" ? 0 : 1,
    backgroundColor: blockColors[block.style],
  })
  const text = new TextRenderable(renderer, {
    id: `transcript-entry-${index}-text`,
    width: "100%",
    height: "auto",
    wrapMode: block.style === "tool" ? "none" : "word",
    truncate: block.style === "tool",
    bg: blockColors[block.style],
    content: block.content,
  })
  root.add(text)
  return { ...block, root, text }
}

function updateBlocks(
  renderer: CliRenderer,
  scrollBox: ScrollBoxRenderable,
  renderedBlocks: RenderedBlock[],
  blocks: DisplayBlock[],
): void {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as DisplayBlock
    let rendered = renderedBlocks[index]
    if (!rendered || rendered.style !== block.style) {
      rendered?.root.destroyRecursively()
      rendered = createBlock(renderer, index, block)
      renderedBlocks[index] = rendered
      scrollBox.add(rendered.root, index)
    } else if (rendered.content !== block.content) {
      rendered.text.content = block.content
      rendered.content = block.content
    }
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
  const streaming = new TextRenderable(renderer, {
    id: "transcript-streaming",
    width: "100%",
    height: "auto",
    visible: false,
    content: "",
  })
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
      updateBlocks(renderer, scrollBox, renderedBlocks, displayBlocks(snapshot))
      const currentStreamingText = streamingText(snapshot)
      streaming.content = currentStreamingText
      streaming.visible = currentStreamingText.length > 0
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
