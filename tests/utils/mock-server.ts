export type MockRequestContext = {
  id: string
  sequence: number
  method: string
  url: string
  headers: Record<string, string>
  modelId?: string
  body: Record<string, unknown>
  system: unknown
  messages: unknown[]
  tools: unknown[]
}

export type MockResponse =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; arguments: unknown; callId?: string }
  | { type: "tool_calls"; calls: Array<{ name: string; arguments: unknown; callId?: string }> }
  | { type: "http_error"; status: number; body?: unknown }

export type MockResponseHandler = (request: MockRequestContext) => MockResponse | Promise<MockResponse>

export type MockPendingRequest = MockRequestContext & {
  /** 向当前等待中的 HTTP 请求返回结构化响应；每个请求只能调用一次。 */
  respond(response: MockResponse): void
}

export type MockTakeFilter = { modelId?: string }

export type MockServer = {
  url: string
  /** 捕获一条尚未由处理器接管的请求；筛选不匹配的请求会留给后续捕获。 */
  take(filter?: MockTakeFilter): Promise<MockPendingRequest>
  /** 为所有未设置模型处理器的请求设置持续生效的响应逻辑。 */
  handle(handler: MockResponseHandler): void
  /** 为指定模型设置持续生效的响应逻辑。 */
  handleModel(modelId: string, handler: MockResponseHandler): void
  requests(): Promise<MockRequestContext[]>
  stop(): void
}

type Pending = {
  context: MockRequestContext
  resolve: (response: MockResponse) => void
  responded: boolean
}

type TakeWaiter = {
  filter: MockTakeFilter
  resolve: (request: MockPendingRequest) => void
}

function headers(request: Request): Record<string, string> {
  return Object.fromEntries(request.headers.entries())
}

function objectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function matches(context: MockRequestContext, filter: MockTakeFilter): boolean {
  return filter.modelId === undefined || context.modelId === filter.modelId
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function buildSseBody(response: Exclude<MockResponse, { type: "http_error" }>, modelId: string | undefined): string {
  const id = `msg_${crypto.randomUUID()}`
  const model = modelId ?? "mock-model"
  let body = sseEvent("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [],
      model,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })
  if (response.type === "text") {
    body += sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })
    body += sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: response.text },
    })
    body += sseEvent("content_block_stop", { type: "content_block_stop", index: 0 })
    body += sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    })
  } else {
    const calls = response.type === "tool_call" ? [response] : response.calls
    for (const [index, call] of calls.entries()) {
      body += sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: call.callId ?? `tool_${crypto.randomUUID()}`,
          name: call.name,
          input: {},
        },
      })
      body += sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) },
      })
      body += sseEvent("content_block_stop", { type: "content_block_stop", index })
    }
    body += sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    })
  }
  body += sseEvent("message_stop", { type: "message_stop" })
  return body
}

function httpResponse(response: MockResponse, modelId: string | undefined): Response {
  if (response.type === "http_error") {
    const body = response.body === undefined ? { error: { message: `Mock HTTP ${response.status}` } } : response.body
    return Response.json(body, { status: response.status })
  }
  return new Response(buildSseBody(response, modelId), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

/**
 * 启动可由测试逐请求控制的 Anthropic Messages Mock Server。
 * 传入字符串时保留旧测试的固定文本响应行为。
 */
export async function startMockServer(responseText?: string): Promise<MockServer> {
  const history: MockRequestContext[] = []
  const pending: Pending[] = []
  const waiters: TakeWaiter[] = []
  const modelHandlers = new Map<string, MockResponseHandler>()
  let defaultHandler: MockResponseHandler | undefined = responseText
    ? () => ({ type: "text", text: responseText })
    : undefined
  let sequence = 0

  const controlled = (item: Pending): MockPendingRequest => ({
    ...item.context,
    respond(response) {
      if (item.responded) throw new Error(`Mock 请求 ${item.context.id} 已经响应`)
      item.responded = true
      const index = pending.indexOf(item)
      if (index >= 0) pending.splice(index, 1)
      item.resolve(response)
    },
  })

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== "POST" || url.pathname !== "/v1/messages")
        return new Response("not found", { status: 404 })
      const body = objectBody(await request.json())
      const context: MockRequestContext = {
        id: crypto.randomUUID(),
        sequence: sequence++,
        method: request.method,
        url: request.url,
        headers: headers(request),
        ...(typeof body.model === "string" ? { modelId: body.model } : {}),
        body,
        system: body.system,
        messages: Array.isArray(body.messages) ? body.messages : [],
        tools: Array.isArray(body.tools) ? body.tools : [],
      }
      history.push(context)
      const handler = (context.modelId ? modelHandlers.get(context.modelId) : undefined) ?? defaultHandler
      if (handler) return httpResponse(await handler(structuredClone(context)), context.modelId)

      const response = await new Promise<MockResponse>((resolve) => {
        const item: Pending = { context, resolve, responded: false }
        const waiterIndex = waiters.findIndex((waiter) => matches(context, waiter.filter))
        if (waiterIndex < 0) {
          pending.push(item)
          return
        }
        const waiter = waiters.splice(waiterIndex, 1)[0]
        if (!waiter) throw new Error("Mock 请求等待器意外丢失")
        waiter.resolve(controlled(item))
      })
      return httpResponse(response, context.modelId)
    },
  })

  return {
    url: `http://localhost:${server.port}`,
    take(filter = {}) {
      const index = pending.findIndex((item) => matches(item.context, filter))
      const item = index >= 0 ? pending[index] : undefined
      if (item) return Promise.resolve(controlled(item))
      return new Promise((resolve) => waiters.push({ filter, resolve }))
    },
    handle(handler) {
      defaultHandler = handler
    },
    handleModel(modelId, handler) {
      if (!modelId) throw new Error("Mock 模型 ID 不能为空")
      modelHandlers.set(modelId, handler)
    },
    async requests() {
      return structuredClone(history)
    },
    stop() {
      void server.stop()
    },
  }
}

if (import.meta.main) {
  const text = process.argv[2] ?? "架构可行性验证：Mock 链路通过"
  const mock = await startMockServer(text)
  console.log(`Mock server 已启动：${mock.url}`)
  console.log(`响应内容：${text}`)
  console.log("按 Ctrl+C 停止")
}
