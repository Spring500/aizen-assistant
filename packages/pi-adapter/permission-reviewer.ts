import {
  type Api,
  type Message,
  type Model,
  StringEnum,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { AiPermissionReviewer, AiReviewDecision, AiReviewRequest } from "../core/tool-permissions/types.ts"

const reviewToolName = "submit_permission_review"
const maximumAttempts = 2
const systemPrompt = `你负责评估一次工具调用的局部风险。
你只依据工具参数、Agent 声明的调用意图、工作目录和固定规则分析，不推断主对话中的用户授权。
你必须调用 submit_permission_review，返回 allow、deny 或 needHumanReview，并给出简洁理由。
有明显风险但需要用户取舍时返回 needHumanReview；不得输出普通文本代替工具调用。`

const reviewTool = {
  name: reviewToolName,
  description: "提交工具权限风险评估",
  parameters: Type.Object(
    {
      decision: StringEnum(["allow", "deny", "needHumanReview"] as const),
      reason: Type.String({ minLength: 1, maxLength: 500 }),
      question: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    },
    { additionalProperties: false },
  ),
}

function decision(call: ToolCall): AiReviewDecision {
  if (call.name !== reviewToolName) throw new Error(`必须调用 ${reviewToolName}`)
  const value = call.arguments as { decision?: unknown; reason?: unknown; question?: unknown }
  if (typeof value.reason !== "string" || !value.reason.trim()) throw new Error("审核理由不能为空")
  if (value.decision === "allow" || value.decision === "deny")
    return { type: value.decision, reason: value.reason.trim() }
  if (value.decision === "needHumanReview")
    return {
      type: value.decision,
      reason: value.reason.trim(),
      ...(typeof value.question === "string" && value.question.trim() ? { question: value.question.trim() } : {}),
    }
  throw new Error("审核结论无效")
}

function correction(call: ToolCall, message: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: `审核提交无效：${message}。请重新调用 ${reviewToolName}。` }],
    isError: true,
    timestamp: Date.now(),
  }
}

export class PiPermissionReviewer implements AiPermissionReviewer {
  constructor(
    readonly runtime: ModelRuntime,
    readonly model: Model<Api>,
  ) {}

  /** 使用独立、无历史的模型请求评估单次工具调用。 */
  async review(request: AiReviewRequest, signal?: AbortSignal): Promise<AiReviewDecision> {
    const messages: Message[] = [
      {
        role: "user",
        content: JSON.stringify(request),
        timestamp: Date.now(),
      },
    ]
    let protocolError = "审核模型没有提交结论"
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      const response = await this.runtime.complete(
        this.model,
        { systemPrompt, messages, tools: [reviewTool] },
        { maxRetries: 0, ...(signal ? { signal } : {}) },
      )
      if (response.stopReason === "error") throw new Error(response.errorMessage ?? "审核模型请求失败")
      const calls = response.content.filter((part): part is ToolCall => part.type === "toolCall")
      if (calls.length === 1 && calls[0]) {
        try {
          return decision(calls[0])
        } catch (error) {
          protocolError = error instanceof Error ? error.message : String(error)
          messages.push(response, correction(calls[0], protocolError))
          continue
        }
      }
      protocolError = calls.length === 0 ? `模型没有调用 ${reviewToolName}` : "一次只能提交一个审核结论"
      messages.push(response, { role: "user", content: protocolError, timestamp: Date.now() })
    }
    throw new Error(`审核模型连续 ${maximumAttempts} 次未返回有效结论：${protocolError}`)
  }
}
