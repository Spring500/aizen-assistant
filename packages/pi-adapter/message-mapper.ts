import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type {
  AssistantMessage as PiAssistantMessage,
  ImageContent as PiImageContent,
  TextContent as PiTextContent,
  ToolResultMessage as PiToolResultMessage,
  UserMessage as PiUserMessage,
} from "@earendil-works/pi-ai"
import type {
  AssistantMessage,
  ImagePart,
  JsonValue,
  MessageRecord,
  TextPart,
  Timing,
  ToolMessage,
  TurnInputItem,
} from "../core/session-format.ts"

export type MappedTurnInput = {
  message: PiUserMessage
  persistent: boolean
}

function inputPartToPi(part: TextPart | ImagePart): PiTextContent | PiImageContent {
  if (part.kind === "text") return { type: "text", text: part.text }
  return { type: "image", data: part.data, mimeType: part.mimeType }
}

function piPartToCore(part: PiTextContent | PiImageContent): TextPart | ImagePart {
  if (part.type === "text") return { kind: "text", text: part.text }
  return { kind: "image", data: part.data, mimeType: part.mimeType }
}

function inputText(item: TurnInputItem): string {
  const content = item.parts.map((part) => (part.kind === "text" ? part.text : `[图片 ${part.mimeType}]`)).join("\n")
  if (item.source === "user" && item.role === "user") return content
  return `<aizen-input source="${item.source}" role="${item.role}">\n${content}\n</aizen-input>`
}

export function turnInputToPi(items: TurnInputItem[], timestamp: number): MappedTurnInput[] {
  return items.map((item, index) => ({
    persistent: item.useLater,
    message: {
      role: "user",
      content: item.parts.every((part) => part.kind === "text")
        ? inputText(item)
        : [
            { type: "text", text: inputText({ ...item, parts: item.parts.filter((part) => part.kind === "text") }) },
            ...item.parts.filter((part): part is ImagePart => part.kind === "image").map(inputPartToPi),
          ],
      timestamp: timestamp + index,
    },
  }))
}

export function coreMessageToPi(
  message: MessageRecord["message"],
  timestamp: number,
): PiAssistantMessage | PiToolResultMessage {
  if (message.role === "tool") {
    return {
      role: "toolResult",
      toolCallId: message.callId,
      toolName: message.name,
      content: message.parts.map(inputPartToPi),
      details: message.details,
      isError: message.isError,
      timestamp,
    }
  }
  const stopReason = message.stopReason === "tool_use" ? "toolUse" : message.stopReason
  if (
    stopReason !== "stop" &&
    stopReason !== "length" &&
    stopReason !== "toolUse" &&
    stopReason !== "error" &&
    stopReason !== "aborted"
  ) {
    throw new Error(`无法转换的结束原因：${message.stopReason}`)
  }
  return {
    role: "assistant",
    content: message.parts.map((part) => {
      if (part.kind === "text") return { type: "text" as const, text: part.text }
      if (part.kind === "thinking") {
        return {
          type: "thinking" as const,
          thinking: part.text,
          ...(part.signature ? { thinkingSignature: part.signature } : {}),
        }
      }
      return {
        type: "toolCall" as const,
        id: part.callId,
        name: part.name,
        arguments: {
          ...(part.arguments as Record<string, unknown>),
          ...(part.declaredIntent ? { declaredIntent: part.declaredIntent } : {}),
        },
        ...(part.signature ? { thoughtSignature: part.signature } : {}),
      }
    }),
    api: message.source.api as PiAssistantMessage["api"],
    provider: message.source.providerId,
    model: message.source.modelId,
    ...(message.source.responseId ? { responseId: message.source.responseId } : {}),
    ...(message.source.responseModel ? { responseModel: message.source.responseModel } : {}),
    usage: {
      ...message.usage,
      totalTokens: message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp,
  }
}

export type MessageTimingMetadata = {
  content?: Map<number, Timing>
  tools?: Map<string, Timing>
}

/** 落盘前的调用目的统一收口：去首尾空白并截断到 50 个码点内，保证满足会话格式校验（1 至 50 个字符）。 */
function normalizedDeclaredIntent(value: string): string {
  const trimmed = value.trim()
  const characters = Array.from(trimmed)
  return characters.length > 50 ? characters.slice(0, 50).join("") : trimmed
}

function toolArguments(argumentsValue: Record<string, unknown>): {
  arguments: JsonValue
  declaredIntent?: string
} {
  const { declaredIntent, ...actualArguments } = argumentsValue
  if (typeof declaredIntent !== "string") return { arguments: actualArguments as JsonValue }
  const normalized = normalizedDeclaredIntent(declaredIntent)
  return {
    arguments: actualArguments as JsonValue,
    ...(normalized ? { declaredIntent: normalized } : {}),
  }
}

export function piMessageToCore(message: AgentMessage, timing: MessageTimingMetadata = {}): MessageRecord["message"] {
  if (message.role === "assistant") {
    const result: AssistantMessage = {
      role: "assistant",
      parts: message.content.map((part, index) => {
        const partTiming = timing.content?.get(index)
        if (part.type === "text")
          return { kind: "text" as const, text: part.text, ...(partTiming ? { timing: partTiming } : {}) }
        if (part.type === "thinking") {
          return {
            kind: "thinking" as const,
            text: part.thinking,
            ...(part.thinkingSignature ? { signature: part.thinkingSignature } : {}),
            ...(partTiming ? { timing: partTiming } : {}),
          }
        }
        const mappedArguments = toolArguments(part.arguments)
        return {
          kind: "tool_call" as const,
          callId: part.id,
          name: part.name,
          arguments: mappedArguments.arguments,
          ...(mappedArguments.declaredIntent ? { declaredIntent: mappedArguments.declaredIntent } : {}),
          ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
        }
      }),
      source: {
        providerId: message.provider,
        modelId: message.model,
        api: message.api,
        ...(message.responseId ? { responseId: message.responseId } : {}),
        ...(message.responseModel ? { responseModel: message.responseModel } : {}),
      },
      stopReason: message.stopReason === "toolUse" ? "tool_use" : message.stopReason,
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      usage: {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        ...(message.usage.reasoning === undefined ? {} : { reasoning: message.usage.reasoning }),
      },
    }
    return result
  }
  if (message.role === "toolResult") {
    const messageTiming = timing.tools?.get(message.toolCallId)
    const result: ToolMessage = {
      role: "tool",
      callId: message.toolCallId,
      name: message.toolName,
      parts: message.content.map(piPartToCore),
      isError: message.isError,
      ...(messageTiming ? { timing: messageTiming } : {}),
      ...(message.details === undefined ? {} : { details: message.details }),
    }
    return result
  }
  throw new Error(`无法保存的 pi 消息角色：${message.role}`)
}
