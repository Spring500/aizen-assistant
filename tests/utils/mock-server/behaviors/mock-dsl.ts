import type { MockBehavior, MockEvent, MockMessage, MockRequestContext } from "../types.ts"
import { parseMockDsl, type MockDslInstruction } from "./dsl-parser.ts"

const parseFailurePrefix = "用户输入无法解析，原样输出结果如下："
const referencePattern = /\{\{([^{}]+)\.Result\}\}/g

function lastUserMessage(messages: MockMessage[]): { text: string; index: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === "user") return { text: message.content, index }
  }
  return undefined
}

function resultsAfter(messages: MockMessage[], index: number): Map<string, string> {
  const results = new Map<string, string>()
  for (const message of messages.slice(index + 1)) {
    if (message.role === "tool" && message.toolCallId) results.set(message.toolCallId, message.content)
  }
  return results
}

function referencedCallIds(instruction: MockDslInstruction): string[] {
  const source = JSON.stringify(instruction)
  return [...source.matchAll(referencePattern)].map((match) => match[1] ?? "")
}

function substitute(value: string, results: Map<string, string>): string {
  return value.replace(referencePattern, (_all, callId: string) => results.get(callId) ?? `{{${callId}.Result}}`)
}

function substituteInstruction(instruction: MockDslInstruction, results: Map<string, string>): MockDslInstruction {
  if (instruction.type === "thinking" || instruction.type === "text")
    return { ...instruction, text: substitute(instruction.text, results) }
  if (instruction.type === "tool") {
    const argumentsValue = JSON.parse(substitute(JSON.stringify(instruction.arguments), results)) as Record<
      string,
      unknown
    >
    return { ...instruction, arguments: argumentsValue }
  }
  return instruction
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Mock 请求已取消"))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(new Error("Mock 请求已取消"))
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

async function hang(signal: AbortSignal): Promise<void> {
  await new Promise<void>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Mock 请求已取消"))
      return
    }
    signal.addEventListener("abort", () => reject(new Error("Mock 请求已取消")), { once: true })
  })
}

function firstPendingStart(instructions: MockDslInstruction[], results: Map<string, string>): number {
  let start = 0
  for (const [index, instruction] of instructions.entries()) {
    if (instruction.type !== "tool") continue
    if (!results.has(instruction.callId)) break
    start = index + 1
  }
  return start
}

/** 执行用户最后一条消息中的 DSL，并仅通过历史工具结果无状态推进多轮调用。 */
export const mockDslBehavior: MockBehavior = async function* (context: MockRequestContext): AsyncIterable<MockEvent> {
  const latest = lastUserMessage(context.messages)
  if (!latest) {
    yield { type: "text", text: `${parseFailurePrefix}\n` }
    yield { type: "finish", reason: "stop" }
    return
  }
  const parsed = parseMockDsl(latest.text)
  if (!parsed.ok) {
    yield { type: "text", text: `${parseFailurePrefix}\n${latest.text}` }
    yield { type: "finish", reason: "stop" }
    return
  }
  const results = resultsAfter(context.messages, latest.index)
  const start = firstPendingStart(parsed.instructions, results)
  if (start >= parsed.instructions.length) {
    yield { type: "finish", reason: "stop" }
    return
  }
  const instructions = parsed.instructions.slice(start)
  const errorIndex = instructions.findIndex((instruction) => instruction.type === "error")
  if (errorIndex >= 0) {
    for (const instruction of instructions.slice(0, errorIndex)) {
      if (instruction.type === "delay") await wait(instruction.milliseconds, context.signal)
    }
    const error = instructions[errorIndex]
    if (error?.type === "error") yield { type: "error", status: error.status, message: error.message }
    return
  }
  let sentTool = false
  for (const original of instructions) {
    const unresolved = referencedCallIds(original).some((callId) => !results.has(callId))
    if (unresolved) break
    const instruction = substituteInstruction(original, results)
    if (instruction.type === "thinking") yield { type: "thinking", text: instruction.text }
    else if (instruction.type === "text") yield { type: "text", text: instruction.text }
    else if (instruction.type === "delay") await wait(instruction.milliseconds, context.signal)
    else if (instruction.type === "hang") await hang(context.signal)
    else if (instruction.type === "tool") {
      if (results.has(instruction.callId)) continue
      yield { type: "tool", callId: instruction.callId, name: instruction.name, arguments: instruction.arguments }
      sentTool = true
    }
  }
  yield { type: "finish", reason: sentTool ? "toolUse" : "stop" }
}
