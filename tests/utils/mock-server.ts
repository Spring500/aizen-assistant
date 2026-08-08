import { encodeAnthropicEvents } from "./mock-server/encoders/anthropic-messages.ts"
import { encodeOpenAiEvents } from "./mock-server/encoders/openai-completions.ts"
import { normalizeRequest } from "./mock-server/normalize.ts"
import { mockBehaviorRegistry, registeredMockModelIds } from "./mock-server/registry.ts"
import type { MockEvent, MockProtocol, MockRequestContext } from "./mock-server/types.ts"

export type { MockBehavior, MockEvent, MockProtocol, MockRequestContext } from "./mock-server/types.ts"

export type MockResponse =
  | { type: "text"; text: string; inputTokens?: number; outputTokens?: number }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown>; callId?: string }
  | { type: "tool_calls"; calls: Array<{ name: string; arguments: Record<string, unknown>; callId?: string }> }
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
  /** 返回当前已注册的内置模型行为 ID。 */
  registeredModels(): string[]
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

function protocolForPath(pathname: string): MockProtocol | undefined {
  if (pathname === "/v1/messages") return "anthropic-messages"
  if (pathname === "/v1/chat/completions") return "openai-completions"
  return undefined
}

function eventsForResponse(response: MockResponse): AsyncIterable<MockEvent> {
  return (async function* () {
    if (response.type === "http_error") {
      yield {
        type: "error",
        status: response.status,
        message: `Mock HTTP ${response.status}`,
        ...(response.body === undefined ? {} : { body: response.body }),
      }
      return
    }
    if (response.type === "text") {
      yield { type: "text", text: response.text }
      yield {
        type: "finish",
        reason: "stop",
        ...(response.inputTokens === undefined ? {} : { inputTokens: response.inputTokens }),
        ...(response.outputTokens === undefined ? {} : { outputTokens: response.outputTokens }),
      }
      return
    }
    const calls = response.type === "tool_call" ? [response] : response.calls
    for (const [index, call] of calls.entries())
      yield {
        type: "tool",
        callId: call.callId ?? `tool_${index}_${crypto.randomUUID()}`,
        name: call.name,
        arguments: call.arguments,
      }
    yield { type: "finish", reason: "toolUse" }
  })()
}

function copyContext(context: MockRequestContext): MockRequestContext {
  const { signal, ...serializable } = context
  return { ...structuredClone(serializable), signal }
}

async function responseForBehavior(events: AsyncIterable<MockEvent>, context: MockRequestContext): Promise<Response> {
  const iterator = events[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) {
    const finish = (async function* (): AsyncIterable<MockEvent> {
      yield { type: "finish", reason: "stop" }
    })()
    return context.protocol === "anthropic-messages"
      ? encodeAnthropicEvents(finish, context)
      : encodeOpenAiEvents(finish, context)
  }
  if (first.value.type === "error")
    return Response.json(first.value.body ?? { error: { message: first.value.message } }, {
      status: first.value.status,
    })
  const prefixed = (async function* (): AsyncIterable<MockEvent> {
    yield first.value
    while (true) {
      const next = await iterator.next()
      if (next.done) return
      yield next.value
    }
  })()
  return context.protocol === "anthropic-messages"
    ? encodeAnthropicEvents(prefixed, context)
    : encodeOpenAiEvents(prefixed, context)
}

function responseForCompatibility(response: MockResponse, context: MockRequestContext): Response {
  if (response.type === "http_error")
    return Response.json(response.body ?? { error: { message: `Mock HTTP ${response.status}` } }, {
      status: response.status,
    })
  const events = eventsForResponse(response)
  return context.protocol === "anthropic-messages"
    ? encodeAnthropicEvents(events, context)
    : encodeOpenAiEvents(events, context)
}

/**
 * 启动可由测试逐请求控制的双协议 Mock Server。
 * 传入字符串时保留旧测试的固定文本响应行为；显式处理器优先于内置行为注册表。
 */
export async function startMockServer(
  responseText?: string,
  options?: { port?: number; strictModels?: boolean },
): Promise<MockServer> {
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
    port: options?.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url)
      const protocol = protocolForPath(url.pathname)
      if (request.method !== "POST" || !protocol) return new Response("not found", { status: 404 })
      let body: Record<string, unknown>
      try {
        body = objectBody(await request.json())
      } catch {
        return Response.json({ error: { message: "请求体必须是 JSON 对象" } }, { status: 400 })
      }
      const controller = new AbortController()
      request.signal.addEventListener("abort", () => controller.abort(), { once: true })
      const context = normalizeRequest({
        id: crypto.randomUUID(),
        sequence: sequence++,
        method: request.method,
        url: request.url,
        headers: headers(request),
        protocol,
        body,
        signal: controller.signal,
      })
      history.push(context)
      const handler = (context.modelId ? modelHandlers.get(context.modelId) : undefined) ?? defaultHandler
      if (handler) return responseForCompatibility(await handler(copyContext(context)), context)
      const behavior = context.modelId ? mockBehaviorRegistry[context.modelId] : undefined
      if (behavior) return await responseForBehavior(behavior(copyContext(context)), context)
      if (context.modelId && options?.strictModels)
        return Response.json(
          {
            error: {
              message: `未注册 Mock 模型：${context.modelId}；可用模型：${registeredMockModelIds().join("、")}`,
            },
          },
          { status: 404 },
        )
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
      return responseForCompatibility(response, context)
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
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
    registeredModels: registeredMockModelIds,
    async requests() {
      return history.map(copyContext)
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
