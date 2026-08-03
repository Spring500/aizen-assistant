import type { HumanReviewRequest } from "../core/tool-permissions/types.ts"

export type PermissionParameterPreview = {
  lines: string[]
  truncated: boolean
  fullText: string
}

function normalize(value: string): string {
  return Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      if (character === "\n") return " ⏎ "
      if (character === "\r") return ""
      if (character === "\t") return " ⇥ "
      if (code < 32 || code === 127) return `\\u${code.toString(16).padStart(4, "0")}`
      return character
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
}

function headTail(value: string, maximumCells: number): { value: string; truncated: boolean } {
  if (Bun.stringWidth(value) <= maximumCells) return { value, truncated: false }
  const characters = Array.from(value)
  let headLength = Math.ceil(characters.length / 2)
  let tailLength = characters.length - headLength
  while (headLength + tailLength > 0) {
    const omitted = characters.length - headLength - tailLength
    const marker = `…[省略 ${omitted} 个字符]…`
    const candidate = `${characters.slice(0, headLength).join("")}${marker}${characters.slice(-tailLength).join("")}`
    if (Bun.stringWidth(candidate) <= maximumCells) return { value: candidate, truncated: true }
    if (headLength > tailLength) headLength -= 1
    else tailLength -= 1
  }
  const marker = `…[省略 ${characters.length} 个字符]…`
  return { value: marker, truncated: true }
}

function wrap(value: string, width: number, maximumLines: number): string[] {
  const lines: string[] = []
  let current = ""
  for (const character of value) {
    if (current && Bun.stringWidth(current + character) > width) {
      lines.push(current)
      current = character
    } else current += character
  }
  if (current || lines.length === 0) lines.push(current)
  return lines.slice(0, maximumLines)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function summary(request: HumanReviewRequest): string {
  const args = object(request.arguments) ?? {}
  if (request.toolName === "bash") {
    const command = typeof args.command === "string" ? args.command : ""
    const timeout = typeof args.timeout === "number" ? ` · timeout=${args.timeout}s` : ""
    return `command: ${normalize(command)}${timeout}`
  }
  if (request.toolName === "read")
    return `path: ${String(args.path ?? "")} · offset: ${String(args.offset ?? "未设置")} · limit: ${String(args.limit ?? "未设置")}`
  if (request.toolName === "write") {
    const content = typeof args.content === "string" ? args.content : ""
    return `path: ${String(args.path ?? "")} · 正文: ${content.split(/\r?\n/).length} 行 / ${Array.from(content).length} 字符`
  }
  if (request.toolName === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits : []
    return `path: ${String(args.path ?? "")} · 替换块: ${edits.length}`
  }
  return `参数: ${normalize(JSON.stringify(request.arguments))}`
}

/** 按当前终端宽度和指定高度生成真正自动换行的头尾参数预览。 */
export function permissionParameterPreview(
  request: HumanReviewRequest,
  terminalWidth: number,
  maximumLines = 3,
): PermissionParameterPreview {
  const width = Math.max(20, terminalWidth - 2)
  const height = Math.max(1, maximumLines)
  const fullText = summary(request)
  const shortened = headTail(fullText, width * height)
  return {
    lines: wrap(shortened.value, width, height),
    truncated: shortened.truncated,
    fullText,
  }
}
