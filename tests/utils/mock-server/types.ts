export type MockProtocol = "anthropic-messages" | "openai-completions"

/** 归一化后的对话消息，供行为模块在不区分模型协议时读取历史。 */
export type MockMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

/** 归一化后的工具定义。 */
export type MockTool = {
  name: string
  description?: string
  parameters: Record<string, unknown>
  /** 保留 Anthropic 原始字段，兼容既有测试的请求断言。 */
  input_schema?: Record<string, unknown>
}

/** Mock Server 交给行为模块的协议无关请求上下文。 */
export type MockRequestContext = {
  id: string
  sequence: number
  method: string
  url: string
  headers: Record<string, string>
  protocol: MockProtocol
  modelId?: string
  /** 原始 HTTP 请求体，仅用于诊断；行为模块不得依赖协议私有字段。 */
  body: Record<string, unknown>
  system: string
  /** 原始协议消息，保留既有测试装置的请求检查语义。 */
  messages: unknown[]
  /** 归一化后的消息，仅供行为模块使用。 */
  normalizedMessages: MockMessage[]
  tools: MockTool[]
  signal: AbortSignal
}

export type MockFinishReason = "stop" | "toolUse"

/** 行为模块产出的协议无关流事件。 */
export type MockEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; callId: string; name: string; arguments: Record<string, unknown> }
  | { type: "finish"; reason: MockFinishReason; inputTokens?: number; outputTokens?: number }
  | { type: "error"; status: number; message: string; body?: unknown }

/** 一个 Mock 模型的无状态行为模块。 */
export type MockBehavior = (context: MockRequestContext) => AsyncIterable<MockEvent>
