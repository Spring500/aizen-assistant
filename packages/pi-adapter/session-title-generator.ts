import type { Api, AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

const titleToolName = "set_session_title"
const maximumTitleLength = 80
const maximumAttempts = 3
const systemPrompt = `你负责根据用户第一条消息生成便于日后查找的会话标题。
标题必须使用用户消息的语言，准确概括主要目标，不得回答用户的问题。
你必须调用 set_session_title 工具提交标题，不得只输出普通文本。`

const titleTool = {
  name: titleToolName,
  description: "提交最终会话标题",
  parameters: Type.Object(
    {
      title: Type.String({ minLength: 1, maxLength: maximumTitleLength, description: "单行、简洁的会话标题" }),
    },
    { additionalProperties: false },
  ),
}

function titleFromCall(call: ToolCall): string {
  if (call.name !== titleToolName) throw new Error(`必须调用 ${titleToolName} 工具`)
  const title = call.arguments.title
  if (typeof title !== "string") throw new Error("标题工具缺少字符串参数 title")
  const normalized = title.trim()
  if (!normalized) throw new Error("标题不能为空")
  if (/\r|\n/.test(normalized)) throw new Error("标题必须为单行文本")
  if (Array.from(normalized).length > maximumTitleLength) throw new Error(`标题不能超过 ${maximumTitleLength} 个字符`)
  return normalized
}

function correction(call: ToolCall, message: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: `标题提交无效：${message}。请修正后再次调用 ${titleToolName}。` }],
    isError: true,
    timestamp: Date.now(),
  }
}

function inspect(message: AssistantMessage): { title?: string; feedback: Message[]; error?: string } {
  const calls = message.content.filter((part): part is ToolCall => part.type === "toolCall")
  if (calls.length === 0) {
    const error = `模型没有调用 ${titleToolName}`
    return {
      error,
      feedback: [
        { role: "user", content: `标题提交无效：${error}。请再次调用 ${titleToolName}。`, timestamp: Date.now() },
      ],
    }
  }
  if (calls.length > 1) {
    const error = "一次只能提交一个标题"
    return { error, feedback: calls.map((call) => correction(call, error)) }
  }
  const call = calls[0]
  if (!call) throw new Error("标题工具调用意外丢失")
  try {
    return { title: titleFromCall(call), feedback: [] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: message, feedback: [correction(call, message)] }
  }
}

/** 使用指定模型执行独立的会话标题生成任务，并在协议错误时最多纠正三轮。 */
export async function generateSessionTitle(
  runtime: ModelRuntime,
  model: Model<Api>,
  firstUserMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  const messages: Message[] = [{ role: "user", content: firstUserMessage, timestamp: Date.now() }]
  let protocolError = "模型没有提交标题"
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    const response = await runtime.complete(
      model,
      { systemPrompt, messages, tools: [titleTool] },
      { maxRetries: 0, ...(signal ? { signal } : {}) },
    )
    if (response.stopReason === "error") throw new Error(response.errorMessage ?? "命名模型请求失败")
    const result = inspect(response)
    if (result.title) return result.title
    protocolError = result.error ?? protocolError
    messages.push(response, ...result.feedback)
  }
  throw new Error(`命名模型连续 ${maximumAttempts} 次未正确提交标题：${protocolError}`)
}
