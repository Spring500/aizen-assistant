import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core"
import type { ResponseMetrics } from "../core/types.ts"
import { MIN_OUTPUT_ROWS } from "./footer-layout.ts"
import { systemColors } from "./theme.ts"

export type OutputTool = {
  id: string
  name: string
  intent?: string
  outputPreview?: string
  isFinished: boolean
  isError: boolean
}

export type OutputData = {
  streamingText: string
  streamingThinking: string
  metrics?: ResponseMetrics
  tools: OutputTool[]
}

export type OutputPanel = {
  /** 输出区根节点，由调用方添加到 renderer.root 的指定位置。 */
  readonly root: BoxRenderable
  readonly isDestroyed: boolean
  /** 调整输出区总高度（行数），并重排工具行与流式行的分配。 */
  setHeight(height: number): void
  /** 用最新快照数据更新工具行与流式行内容。 */
  update(data: OutputData): void
  setVisible(visible: boolean): void
  destroy(): void
}

/** 将 CRLF/CR 统一规范化为 LF。 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function lastLine(text: string): string {
  const normalized = normalizeNewlines(text).replace(/\n+$/, "")
  if (!normalized) return ""
  const lines = normalized.split("\n")
  return lines.at(-1) ?? ""
}

function lastLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return ""
  const lines = normalizeNewlines(text).split("\n")
  if (lines.length <= maxLines) return lines.join("\n")
  return `… 前面 ${lines.length - maxLines} 行省略\n${lines.slice(-maxLines).join("\n")}`
}

function toolLine(tool: OutputTool): string {
  const status = tool.isError ? "失败" : tool.isFinished ? "完成" : "运行中"
  const output = tool.outputPreview ? lastLine(tool.outputPreview) : "等待输出"
  return `[${tool.name}] ${tool.intent?.trim() || "未提供目的"} | ${status}：${output}`
}

function metricText(metrics: ResponseMetrics | undefined): string {
  if (!metrics) return ""
  const hours = Math.floor(metrics.elapsedSeconds / 3600)
  const minutes = Math.floor((metrics.elapsedSeconds % 3600) / 60)
  const seconds = metrics.elapsedSeconds % 60
  const duration = [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${seconds}s`].filter(Boolean).join(" ")
  return ` | 耗时 ${duration} · 生成 ${metrics.outputTokens} tokens`
}

/** 创建聊天 footer 的输出区：工具行（每工具一行，超出截断）在上，流式输出（保底 3 行）在下。 */
export function createOutputPanel(renderer: CliRenderer): OutputPanel {
  const root = new BoxRenderable(renderer, {
    id: "footer-output",
    width: "100%",
    height: 1,
    flexDirection: "column",
  })
  const toolsText = new TextRenderable(renderer, {
    id: "footer-output-tools",
    width: "100%",
    height: 0,
    wrapMode: "none",
    truncate: true,
    fg: systemColors.live,
  })
  const streamText = new TextRenderable(renderer, {
    id: "footer-output-stream",
    width: "100%",
    height: 1,
    wrapMode: "word",
    fg: systemColors.live,
  })
  root.add(toolsText)
  root.add(streamText)

  let height = MIN_OUTPUT_ROWS
  let data: OutputData = { streamingText: "", streamingThinking: "", tools: [] }
  let destroyed = false

  const render = () => {
    const hasStream = data.streamingText !== "" || data.streamingThinking !== ""
    // 工具行上限：有流式内容时保留流式保底行，否则工具可占满整个输出区。
    const maxToolRows = hasStream ? Math.max(0, height - MIN_OUTPUT_ROWS) : Math.max(0, height)
    let toolRows: string[] = []
    if (data.tools.length > 0 && maxToolRows > 0) {
      if (data.tools.length > maxToolRows) {
        const shown = data.tools.slice(0, Math.max(1, maxToolRows - 1))
        toolRows = [...shown.map(toolLine), `… 还有 ${data.tools.length - shown.length} 个工具`]
      } else toolRows = data.tools.map(toolLine)
    }
    toolsText.content = toolRows.join("\n")
    toolsText.height = toolRows.length
    const source = data.streamingText
      ? `[助手流式] ${data.streamingText}`
      : data.streamingThinking
        ? `[思考流式] ${data.streamingThinking}`
        : ""
    // 无流式内容时流式区不占行；有流式时尽量用满剩余空间（保底 MIN_OUTPUT_ROWS）。
    const streamRows = hasStream ? Math.max(1, height - toolRows.length) : 0
    streamText.content = source ? `${lastLines(source, streamRows)}${metricText(data.metrics)}` : ""
    streamText.height = streamRows
    // 实际占用高度 = 内容所需行数（工具行 + 流式行）；全空时收缩到最小 1 行
    // （OpenTUI 布局强制 Box 高度至少为 1），footer 底部相应留白。
    root.height = Math.max(1, toolRows.length + streamRows)
  }

  return {
    root,
    get isDestroyed() {
      return destroyed
    },
    setHeight(next) {
      if (destroyed) return
      height = Math.max(MIN_OUTPUT_ROWS, next)
      root.height = height
      render()
    },
    update(next) {
      if (destroyed) return
      data = next
      render()
    },
    setVisible(visible) {
      if (destroyed) return
      root.visible = visible
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      root.destroyRecursively()
    },
  }
}
