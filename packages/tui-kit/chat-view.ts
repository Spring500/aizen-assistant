import { type CliRenderer, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import type { CoreSnapshot } from "../core/types.ts"

export type ChatView = {
  header: TextRenderable
  transcript: TextRenderable
  scrollBox: ScrollBoxRenderable
  status: TextRenderable
  update(snapshot: CoreSnapshot): void
}

function messageText(snapshot: CoreSnapshot): string {
  const lines: string[] = []
  for (const entry of snapshot.transcript) {
    if (entry.type === "input") {
      for (const item of entry.items) {
        const text = item.parts
          .filter((part) => part.kind === "text")
          .map((part) => part.text)
          .join("\n")
        lines.push(item.source === "user" ? `[你] ${text}` : `[额外消息:${item.source}] ${text}`)
      }
    } else if (entry.type === "message") {
      if (entry.message.role === "assistant") {
        for (const part of entry.message.parts) {
          if (part.kind === "text") lines.push(`[助手] ${part.text}`)
          if (part.kind === "thinking") lines.push(`[思考] ${part.text}`)
          if (part.kind === "tool_call") lines.push(`[工具] ${part.name}`)
        }
      } else {
        const text = entry.message.parts
          .filter((part) => part.kind === "text")
          .map((part) => part.text)
          .join("\n")
        lines.push(`[工具结果:${entry.message.name}] ${text}`)
      }
    } else if (entry.outcome !== "completed") {
      lines.push(entry.outcome === "aborted" ? "[已中止]" : "[执行失败]")
    }
    lines.push("")
  }
  if (snapshot.streamingThinking) lines.push(`[思考] ${snapshot.streamingThinking}`)
  if (snapshot.streamingText) lines.push(`[助手] ${snapshot.streamingText}`)
  return lines.join("\n")
}

export function createChatView(renderer: CliRenderer): ChatView {
  const header = new TextRenderable(renderer, { id: "header", height: 1, content: "AizenAssistant" })
  const scrollBox = new ScrollBoxRenderable(renderer, {
    id: "transcript-scroll",
    flexGrow: 1,
    scrollY: true,
    contentOptions: { flexDirection: "column" },
  })
  const transcript = new TextRenderable(renderer, { id: "transcript", width: "100%", height: "auto", content: "" })
  scrollBox.add(transcript)
  const status = new TextRenderable(renderer, { id: "status", height: 1, content: "空闲" })
  renderer.root.add(header)
  renderer.root.add(scrollBox)
  renderer.root.add(status)

  return {
    header,
    transcript,
    scrollBox,
    status,
    update(snapshot) {
      const model = snapshot.currentModel
        ? `${snapshot.currentModel.providerId}/${snapshot.currentModel.modelId}`
        : "未选择模型"
      header.content = `AizenAssistant | ${snapshot.cwd} | ${model}`
      transcript.content = messageText(snapshot)
      const tools = snapshot.activeTools.map((tool) => `${tool.name}${tool.isError ? "（失败）" : ""}`).join("、")
      status.content = snapshot.lastError
        ? `错误：${snapshot.lastError}`
        : tools
          ? `工具：${tools}`
          : snapshot.status === "idle"
            ? "空闲"
            : "处理中"
    },
  }
}
