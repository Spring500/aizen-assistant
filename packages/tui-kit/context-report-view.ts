import {
  BoxRenderable,
  createTextAttributes,
  parseColor,
  ScrollBoxRenderable,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import type { RuntimeToolInfo } from "../core/pi-port.ts"
import type { TurnInputItem } from "../core/session-format.ts"
import type { ContextReport } from "../core/types.ts"
import { createAssistantMarkdownRenderer, createAssistantMarkdownStyles } from "./markdown-renderer.ts"
import type { OverlayManager } from "./overlay-manager.ts"
import { systemColors } from "./theme.ts"

/** 工具节各片段的样式键，渲染时映射为具体颜色，便于对生成结果做纯文本断言。 */
export type ToolSpanStyle =
  | "name"
  | "description"
  | "paramName"
  | "type"
  | "typeString"
  | "typeNumber"
  | "typeBoolean"
  | "typeObject"
  | "typeArray"
  | "separator"
  | "required"
  | "paramDescription"

export type ToolSpan = { text: string; style: ToolSpanStyle }
export type ToolLine = { indent: number; spans: ToolSpan[] }

const toolSpanColors: Record<
  ToolSpanStyle,
  { color: string; attributes: { bold?: boolean; italic?: boolean; dim?: boolean } }
> = {
  name: { color: "#a78bfa", attributes: { bold: true } },
  description: { color: systemColors.secondary, attributes: { italic: true } },
  paramName: { color: "#22d3ee", attributes: {} },
  type: { color: "#e5e7eb", attributes: {} },
  typeString: { color: "#86efac", attributes: {} },
  typeNumber: { color: "#facc15", attributes: {} },
  typeBoolean: { color: "#fb923c", attributes: {} },
  typeObject: { color: "#60a5fa", attributes: {} },
  typeArray: { color: "#67e8f9", attributes: {} },
  separator: { color: "#6b7280", attributes: { dim: true } },
  required: { color: "#fb923c", attributes: { bold: true } },
  paramDescription: { color: systemColors.secondary, attributes: { italic: true } },
}

function schemaObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 把 JSON Schema 的类型信息转成可读的类型片段，数组/枚举单独处理。 */
function typeSpan(schema: Record<string, unknown>): ToolSpan {
  const type = schema.type
  if (type === "array") {
    const items = schemaObject(schema.items)
    const itemType = items?.type
    const label =
      itemType === "string"
        ? "array<string>"
        : itemType === "number" || itemType === "integer"
          ? "array<number>"
          : itemType === "boolean"
            ? "array<boolean>"
            : itemType === "object"
              ? "array<object>"
              : "array"
    return { text: label, style: "typeArray" }
  }
  if (type === "object") return { text: "object", style: "typeObject" }
  if (Array.isArray(schema.enum) && schema.enum.length > 0)
    return { text: `enum[${schema.enum.map((item) => JSON.stringify(item)).join(",")}]`, style: "type" }
  if (type === "string") return { text: "string", style: "typeString" }
  if (type === "number" || type === "integer") return { text: String(type), style: "typeNumber" }
  if (type === "boolean") return { text: "boolean", style: "typeBoolean" }
  return { text: typeof type === "string" ? type : "unknown", style: "type" }
}

/** 递归生成对象参数行；嵌套 object 与 array<object> 逐级加深缩进。 */
function parameterLines(schema: Record<string, unknown>, indent: number): ToolLine[] {
  const properties = schemaObject(schema.properties)
  if (!properties) return []
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : []
  const lines: ToolLine[] = []
  for (const [name, raw] of Object.entries(properties)) {
    const property = schemaObject(raw)
    if (!property) continue
    const spans: ToolSpan[] = [
      { text: "- ", style: "separator" },
      { text: name, style: "paramName" },
    ]
    if (required.includes(name)) spans.push({ text: "*", style: "required" })
    spans.push({ text: " | ", style: "separator" }, typeSpan(property))
    const description =
      typeof property.description === "string" && property.description.trim() ? property.description.trim() : ""
    if (description) spans.push({ text: `  ${description}`, style: "paramDescription" })
    lines.push({ indent, spans })
    if (property.type === "object") lines.push(...parameterLines(property, indent + 1))
    else if (property.type === "array") {
      const items = schemaObject(property.items)
      if (items?.type === "object") lines.push(...parameterLines(items, indent + 1))
    }
  }
  return lines
}

/** 把一个激活工具转成可读的行与着色片段；纯函数，供离屏测试。 */
export function toolLines(tool: RuntimeToolInfo): ToolLine[] {
  const header: ToolSpan[] = [{ text: `[${tool.name}]`, style: "name" }]
  const description = tool.description?.trim()
  if (description) header.push({ text: `  ${description}`, style: "description" })
  const lines: ToolLine[] = [{ indent: 0, spans: header }]
  const schema = schemaObject(tool.parameters)
  if (schema?.type === "object") lines.push(...parameterLines(schema, 1))
  else if (schema) lines.push({ indent: 1, spans: [{ text: "- ", style: "separator" }, typeSpan(schema)] })
  return lines
}

/** 注入上下文条目里的文字部分拼成一段；图片以占位符说明，不渲染二进制。 */
function injectedItemText(item: TurnInputItem): string {
  return item.parts.map((part) => (part.kind === "text" ? part.text : `[图片：${part.mimeType}]`)).join("\n")
}

function spansToChunks(spans: ToolSpan[]): TextChunk[] {
  return spans
    .filter((span) => span.text.length > 0)
    .map((span) => {
      const style = toolSpanColors[span.style]
      return {
        __isChunk: true,
        text: span.text,
        fg: parseColor(style.color),
        attributes: createTextAttributes(style.attributes),
      }
    })
}

function sectionHeader(text: string): StyledText {
  return new StyledText([
    {
      __isChunk: true,
      text,
      fg: parseColor(systemColors.header),
      attributes: createTextAttributes({ bold: true }),
    },
  ])
}

/**
 * 打开只读、可滚动、分章节展示运行时上下文的浮窗：
 * 系统提示词与注入上下文复用聊天记录的 markdown 样式，工具节按参数着色渲染。
 */
export async function showContextReport(
  overlays: OverlayManager,
  report: ContextReport,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    const pageSize = 24
    const handle = overlays.open({
      id: "context-report",
      title: "运行时上下文",
      description: "↑↓ 逐行、PgUp/PgDn 翻页、Enter/Esc 返回",
      contentHeight: pageSize,
      actions: [],
      ...(signal ? { signal } : {}),
      onCancel: () => finish(),
    })
    const renderer = overlays.renderer
    const styles = createAssistantMarkdownStyles()
    const scrollBox = new ScrollBoxRenderable(renderer, {
      scrollY: true,
      width: "100%",
      height: "100%",
      contentOptions: { flexDirection: "column" },
    })
    handle.content.add(scrollBox)

    const addSectionHeader = (text: string) => {
      scrollBox.content.add(
        new TextRenderable(renderer, {
          content: sectionHeader(text),
          width: "100%",
          height: "auto",
          wrapMode: "word",
        }),
      )
    }
    const addPlainText = (text: string) => {
      scrollBox.content.add(
        new TextRenderable(renderer, {
          content: text,
          width: "100%",
          height: "auto",
          wrapMode: "word",
          fg: systemColors.secondary,
        }),
      )
    }
    const addMarkdown = (id: string, content: string) => {
      scrollBox.content.add(createAssistantMarkdownRenderer(renderer, id, content, styles, true))
    }
    const addToolBlock = (tool: RuntimeToolInfo) => {
      const block = new BoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        flexDirection: "column",
        paddingTop: 1,
        paddingBottom: 1,
      })
      for (const line of toolLines(tool)) {
        block.add(
          new TextRenderable(renderer, {
            content: new StyledText(spansToChunks(line.spans)),
            width: "100%",
            height: "auto",
            wrapMode: "word",
            paddingLeft: line.indent * 2,
          }),
        )
      }
      scrollBox.content.add(block)
    }

    addSectionHeader("系统提示词")
    if (report.systemPrompt) addMarkdown("context-report-system", report.systemPrompt)
    else addPlainText("（无）")

    addSectionHeader("下一条消息注入的上下文")
    if (report.injectedItems.length === 0) addPlainText("（无）")
    else {
      for (const [index, item] of report.injectedItems.entries()) {
        addPlainText(`[${item.source}]`)
        addMarkdown(`context-report-injected-${index}`, injectedItemText(item))
      }
    }

    addSectionHeader("工具 Schema")
    const active = new Set(report.activeToolNames)
    const activeTools = report.tools.filter((tool) => active.has(tool.name))
    const inactive = report.tools.filter((tool) => !active.has(tool.name))
    if (activeTools.length === 0) addPlainText("（无）")
    else for (const tool of activeTools) addToolBlock(tool)
    if (inactive.length > 0) {
      addPlainText(`未激活工具：${inactive.map((tool) => tool.name).join("、")}`)
    }

    const finish = () => {
      if (settled) return
      settled = true
      handle.close()
      resolve()
    }
    handle.setActions([
      {
        id: "line",
        key: { name: "up" },
        alternateKeys: [{ name: "down" }],
        label: "↑↓ 逐行",
        run: (key) => scrollBox.scrollBy(key.name === "up" ? -1 : 1),
      },
      {
        id: "page",
        key: { name: "pageup" },
        alternateKeys: [{ name: "pagedown" }],
        label: "PgUp/PgDn 翻页",
        run: (key) => scrollBox.scrollBy(key.name === "pageup" ? -1 : 1, "viewport"),
      },
      { id: "return", key: { name: "return" }, label: "Enter 返回", run: finish },
      { id: "cancel", key: { name: "escape" }, label: "Esc 返回", run: finish },
    ])
  })
}
