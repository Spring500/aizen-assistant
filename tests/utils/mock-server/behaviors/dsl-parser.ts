export type MockDslInstruction =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; callId: string; name: "bash" | "read" | "write" | "edit"; arguments: Record<string, unknown> }
  | { type: "delay"; milliseconds: number }
  | { type: "error"; status: number; message: string }
  | { type: "hang" }

export type MockDslParseResult = { ok: true; instructions: MockDslInstruction[] } | { ok: false; reason: string }

type BlockResult = { content: string; next: number } | { error: string }

const verbs = new Set(["think", "text", "bash", "read", "write", "edit", "delay", "error", "hang"])

function truncateIntent(intent: string): string {
  return Array.from(intent).slice(0, 50).join("")
}

function nonEmptyIndex(lines: string[], index: number): number {
  while (index < lines.length && !lines[index]?.trim()) index++
  return index
}

function block(lines: string[], start: number): BlockResult {
  const content: string[] = []
  let depth = 1
  for (let index = start; index < lines.length; index++) {
    const line = lines[index] ?? ""
    if (line.trim() === "<<<") {
      depth++
      content.push(line)
      continue
    }
    if (line.trim() === ">>>") {
      depth--
      if (depth === 0) return { content: content.join("\n"), next: index + 1 }
      content.push(line)
      continue
    }
    content.push(line)
  }
  return { error: "文本块没有结束标记 >>>" }
}

function simpleText(
  lines: string[],
  index: number,
  verb: "think" | "text",
): { instruction: MockDslInstruction; next: number } | { error: string } {
  const line = lines[index] ?? ""
  const value = line.slice(verb.length).trimStart()
  if (!value) return { error: `${verb} 缺少文本` }
  if (value !== "<<<")
    return { instruction: { type: verb === "think" ? "thinking" : "text", text: value }, next: index + 1 }
  const result = block(lines, index + 1)
  if ("error" in result) return result
  return { instruction: { type: verb === "think" ? "thinking" : "text", text: result.content }, next: result.next }
}

function toolHeader(
  line: string,
  name: "bash" | "read" | "write" | "edit",
): { callId: string; intent: string; argument: string } | undefined {
  const match = new RegExp(`^${name}\\s+(\\S+)\\s+(.+?)\\s*\\|\\s*(.*)$`).exec(line)
  if (!match?.[1] || !match[2] || match[3] === undefined) return undefined
  const intent = match[2].trim()
  const argument = match[3].trim()
  if (!intent || !argument) return undefined
  return { callId: match[1], intent: truncateIntent(intent), argument }
}

function toolArguments(name: "bash" | "read", argument: string, intent: string): Record<string, unknown> {
  return name === "bash" ? { command: argument, declaredIntent: intent } : { path: argument, declaredIntent: intent }
}

function writeInstruction(
  lines: string[],
  index: number,
  header: { callId: string; intent: string; argument: string },
): { instruction: MockDslInstruction; next: number } | { error: string } {
  const marker = nonEmptyIndex(lines, index + 1)
  if (lines[marker]?.trim() !== "<<<") return { error: "write 文件内容必须使用 <<< 和 >>> 包裹" }
  const result = block(lines, marker + 1)
  if ("error" in result) return result
  return {
    instruction: {
      type: "tool",
      callId: header.callId,
      name: "write",
      arguments: { path: header.argument, content: result.content, declaredIntent: header.intent },
    },
    next: result.next,
  }
}

function editInstruction(
  lines: string[],
  index: number,
  header: { callId: string; intent: string; argument: string },
): { instruction: MockDslInstruction; next: number } | { error: string } {
  let cursor = nonEmptyIndex(lines, index + 1)
  if (lines[cursor]?.trim() !== "<<<") return { error: "edit 编辑内容必须使用 <<< 和 >>> 包裹" }
  cursor++
  const edits: Array<{ oldText: string; newText: string }> = []
  while (true) {
    cursor = nonEmptyIndex(lines, cursor)
    if (cursor >= lines.length) return { error: "edit 编辑块没有结束标记 >>>" }
    if (lines[cursor]?.trim() === ">>>") {
      if (edits.length === 0) return { error: "edit 至少需要一对 old 和 new" }
      return {
        instruction: {
          type: "tool",
          callId: header.callId,
          name: "edit",
          arguments: { path: header.argument, edits, declaredIntent: header.intent },
        },
        next: cursor + 1,
      }
    }
    if (lines[cursor]?.trim() !== "old <<<") return { error: "edit 块必须以 old <<< 开始" }
    const old = block(lines, cursor + 1)
    if ("error" in old) return old
    cursor = nonEmptyIndex(lines, old.next)
    if (lines[cursor]?.trim() !== "new <<<") return { error: "edit 的 old 块后必须紧跟 new <<<" }
    const next = block(lines, cursor + 1)
    if ("error" in next) return next
    edits.push({ oldText: old.content, newText: next.content })
    cursor = next.next
  }
}

/** 将聊天输入解析为 mock-dsl 的无副作用指令序列。 */
export function parseMockDsl(input: string): MockDslParseResult {
  const lines = input.replace(/\r\n?/g, "\n").split("\n")
  const instructions: MockDslInstruction[] = []
  const callIds = new Set<string>()
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (!line.trim()) {
      index++
      continue
    }
    const [word] = line.trimStart().split(/\s+/, 1)
    if (!word || !verbs.has(word)) return { ok: false, reason: `无法识别的指令：${line}` }
    if (word === "think" || word === "text") {
      const result = simpleText(lines, index, word)
      if ("error" in result) return { ok: false, reason: result.error }
      instructions.push(result.instruction)
      index = result.next
      continue
    }
    if (word === "delay") {
      const value = line.trimStart().slice("delay".length).trim()
      if (!/^\d+$/.test(value)) return { ok: false, reason: "delay 必须是非负整数毫秒" }
      instructions.push({ type: "delay", milliseconds: Number(value) })
      index++
      continue
    }
    if (word === "error") {
      const match = /^error\s+(\d{3})(?:\s+(.*))?$/.exec(line.trimStart())
      if (!match?.[1] || (!match[2] && !/^error\s+\d{3}$/.test(line.trimStart())))
        return { ok: false, reason: "error 需要三位 HTTP 状态码" }
      const status = Number(match[1])
      if (status < 100 || status > 599) return { ok: false, reason: "error 状态码必须在 100 到 599 之间" }
      instructions.push({ type: "error", status, message: match[2]?.trim() || `Mock HTTP ${status}` })
      index++
      continue
    }
    if (word === "hang") {
      if (line.trim() !== "hang") return { ok: false, reason: "hang 不接受参数" }
      instructions.push({ type: "hang" })
      index++
      continue
    }
    const name = word as "bash" | "read" | "write" | "edit"
    const header = toolHeader(line.trimStart(), name)
    if (!header) return { ok: false, reason: `${name} 需要调用名、意图、| 和参数` }
    if (callIds.has(header.callId)) return { ok: false, reason: `工具调用名重复：${header.callId}` }
    callIds.add(header.callId)
    if (name === "bash" || name === "read") {
      instructions.push({
        type: "tool",
        callId: header.callId,
        name,
        arguments: toolArguments(name, header.argument, header.intent),
      })
      index++
      continue
    }
    const result = name === "write" ? writeInstruction(lines, index, header) : editInstruction(lines, index, header)
    if ("error" in result) return { ok: false, reason: result.error }
    instructions.push(result.instruction)
    index = result.next
  }
  return instructions.length > 0 ? { ok: true, instructions } : { ok: false, reason: "输入为空" }
}
