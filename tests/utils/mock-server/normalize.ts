import type { MockMessage, MockProtocol, MockRequestContext, MockTool } from "./types.ts"

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .map((part) => {
      const item = object(part)
      if (typeof item.text === "string") return item.text
      if (typeof item.content === "string") return item.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value
  const item = object(value)
  if (typeof item.text === "string") return item.text
  return text(value)
}

function anthropicMessages(value: unknown): MockMessage[] {
  if (!Array.isArray(value)) return []
  const result: MockMessage[] = []
  for (const entry of value) {
    const message = object(entry)
    const role = message.role
    if (role === "user" || role === "assistant") {
      const content = message.content
      if (!Array.isArray(content)) {
        result.push({ role, content: contentText(content) })
        continue
      }
      for (const part of content) {
        const block = object(part)
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          result.push({
            role: "tool",
            content: text(block.content),
            toolCallId: block.tool_use_id,
            ...(typeof block.is_error === "boolean" ? { isError: block.is_error } : {}),
          })
        } else if (block.type === "text" || block.type === "thinking") {
          result.push({ role, content: contentText(block) })
        }
      }
    }
  }
  return result
}

function openAiMessages(value: unknown): MockMessage[] {
  if (!Array.isArray(value)) return []
  const result: MockMessage[] = []
  for (const entry of value) {
    const message = object(entry)
    const role = message.role
    if (role === "system" || role === "user" || role === "assistant") {
      result.push({ role, content: contentText(message.content) })
      continue
    }
    if (role === "tool") {
      result.push({
        role: "tool",
        content: contentText(message.content),
        ...(typeof message.tool_call_id === "string" ? { toolCallId: message.tool_call_id } : {}),
        ...(typeof message.name === "string" ? { toolName: message.name } : {}),
      })
    }
  }
  return result
}

function anthropicTools(value: unknown): MockTool[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const tool = object(entry)
    if (typeof tool.name !== "string") return []
    return [
      {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters: object(tool.input_schema),
        input_schema: object(tool.input_schema),
      },
    ]
  })
}

function openAiTools(value: unknown): MockTool[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const tool = object(entry)
    const fn = object(tool.function)
    if (tool.type !== "function" || typeof fn.name !== "string") return []
    return [{ name: fn.name, ...(typeof fn.description === "string" ? { description: fn.description } : {}), parameters: object(fn.parameters) }]
  })
}

/** 将协议私有请求体归一化为行为模块使用的上下文。 */
export function normalizeRequest(input: {
  id: string
  sequence: number
  method: string
  url: string
  headers: Record<string, string>
  protocol: MockProtocol
  body: Record<string, unknown>
  signal: AbortSignal
}): MockRequestContext {
  const { protocol, body } = input
  const system = protocol === "anthropic-messages" ? text(body.system) : ""
  const messages = protocol === "anthropic-messages" ? anthropicMessages(body.messages) : openAiMessages(body.messages)
  const tools = protocol === "anthropic-messages" ? anthropicTools(body.tools) : openAiTools(body.tools)
  return {
    ...input,
    ...(typeof body.model === "string" ? { modelId: body.model } : {}),
    system,
    messages,
    tools,
  }
}
