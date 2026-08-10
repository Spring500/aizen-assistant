import { encodeAnthropicEvents } from "./mock-server/encoders/anthropic-messages.ts"
import { encodeOpenAiEvents } from "./mock-server/encoders/openai-completions.ts"
import { normalizeRequest } from "./mock-server/normalize.ts"
import {
  builtinMockBehavior,
  defaultMockModelBehaviors,
  type MockBehaviorId,
} from "./mock-server/registry.ts"
import type { MockBehavior, MockEvent, MockProtocol, MockRequestContext } from "./mock-server/types.ts"

export type { MockBehavior, MockEvent, MockProtocol, MockRequestContext } from "./mock-server/types.ts"
export type { MockBehaviorId } from "./mock-server/registry.ts"

export type MockResponse =
  | { type: "text"; text: string; inputTokens?: number; outputTokens?: number }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown>; callId?: string }
  | { type: "tool_calls"; calls: Array<{ name: string; arguments: Record<string, unknown>; callId?: string }> }
  | { type: "http_error"; status: number; body?: unknown }

/** 测试观察到的原始协议请求；字段语义保持既有测试接口。 */
export type MockCapturedRequest = {
  id: string
  sequence: number
  method: string
  url: string
  headers: Record<string, string>
  protocol: MockProtocol
  modelId?: string
  body: Record<string, unknown>
  system: unknown
  messages: unknown[]
  tools: unknown[]
}

export type MockResponseHandler = (request: MockCapturedRequest) => MockResponse | Promise<MockResponse>

export type MockPendingRequest = MockCapturedRequest & {
  /** 向当前等待中的测试控制模型请求返回结构化响应；每个请求只能调用一次。 */
  respond(response: MockResponse): void
}

export type MockTakeFilter = { modelId?: string }

export type MockServerOptions = {
  port?: number
  /** 覆盖或补充默认的“模型 ID → 行为类型”映射。 */
  modelBehaviors?: Record<string, MockBehaviorId>
}

export type MockServer = {
  url: string
  /** 捕获一条 test-control 行为尚未由处理器接管的请求。 */
  take(filter?: MockTakeFilter): Promise<MockPendingRequest>
  /** 为全部 test-control 模型设置持续生效的回退响应逻辑。 */
  handle(handler: MockResponseHandler): void
  /** 为指定 test-control 模型设置持续生效的响应逻辑。 */
  handleModel(modelId: string, handler: MockResponseHandler): void
  /** 返回当前已注册的模型 ID。 */
  registeredModels(): string[]
  /** 返回已捕获的原始协议请求。 */
  requests(): Promise<MockCapturedRequest[]>
  stop(): void
}

type Pending = {
  request: MockCapturedRequest
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

function matches(request: MockCapturedRequest, filter: MockTakeFilter): boolean {
  return filter.modelId === undefined || request.modelId === filter.modelId
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

function capturedRequest(context: MockRequestContext): MockCapturedRequest {
  return {
    id: context.id,
    sequence: context.sequence,
    method: context.method,
    url: context.url,
    headers: structuredClone(context.headers),
    protocol: context.protocol,
    ...(context.modelId === undefined ? {} : { modelId: context.modelId }),
    body: structuredClone(context.rawBody),
    system: structuredClone(context.rawBody.system),
    messages: [...context.rawMessages],
    tools: Array.isArray(context.rawBody.tools) ? structuredClone(context.rawBody.tools) : [],
  }
}

function copyCapturedRequest(request: MockCapturedRequest): MockCapturedRequest {
  return structuredClone(request)
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

/**
 * 启动双协议 Mock Server。
 * 内置模型使用默认注册表；测试模型必须在 modelBehaviors 中显式映射为 test-control。
 */
export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const history: MockCapturedRequest[] = []
  const pending: Pending[] = []
  const waiters: TakeWaiter[] = []
  const modelHandlers = new Map<string, MockResponseHandler>()
  const modelBehaviors: Record<string, MockBehaviorId> = {
    ...defaultMockModelBehaviors,
    ...options.modelBehaviors,
  }
  let defaultHandler: MockResponseHandler | undefined
  let sequence = 0

  const controlled = (item: Pending): MockPendingRequest => ({
    ...copyCapturedRequest(item.request),
    respond(response) {
      if (item.responded) throw new Error(`Mock 请求 ${item.request.id} 已经响应`)
      item.responded = true
      const index = pending.indexOf(item)
      if (index >= 0) pending.splice(index, 1)
      item.resolve(response)
    },
  })

  const testControlBehavior: MockBehavior = async function* (context) {
    const request = capturedRequest(context)
    const handler = context.modelId === undefined ? undefined : modelHandlers.get(context.modelId)
    const response = handler
      ? await handler(copyCapturedRequest(request))
      : defaultHandler
        ? await defaultHandler(copyCapturedRequest(request))
        : await new Promise<MockResponse>((resolve) => {
            const item: Pending = { request, resolve, responded: false }
            const waiterIndex = waiters.findIndex((waiter) => matches(request, waiter.filter))
            if (waiterIndex < 0) {
              pending.push(item)
              return
            }
            const waiter = waiters.splice(waiterIndex, 1)[0]
            if (!waiter) throw new Error("Mock 请求等待器意外丢失")
            waiter.resolve(controlled(item))
          })
    yield* eventsForResponse(response)
  }

  const server = Bun.serve({
    port: options.port ?? 0,
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
      const captured = capturedRequest(context)
      history.push(captured)
      const behaviorId = context.modelId === undefined ? undefined : modelBehaviors[context.modelId]
      if (!behaviorId)
        return Response.json(
          {
            error: {
              message: `未注册 Mock 模型：${context.modelId ?? "未提供"}；可用模型：${Object.keys(modelBehaviors)
                .sort()
                .join("、")}`,
            },
          },
          { status: 404 },
        )
      const behavior = behaviorId === "test-control" ? testControlBehavior : builtinMockBehavior(behaviorId)
      return responseForBehavior(behavior(copyContext(context)), context)
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    take(filter = {}) {
      const index = pending.findIndex((item) => matches(item.request, filter))
      const item = index >= 0 ? pending[index] : undefined
      if (item) return Promise.resolve(controlled(item))
      return new Promise((resolve) => waiters.push({ filter, resolve }))
    },
    handle(handler) {
      defaultHandler = handler
    },
    handleModel(modelId, handler) {
      if (modelBehaviors[modelId] !== "test-control")
        throw new Error(`模型 ${modelId} 未注册为 test-control 行为，不能设置测试处理器`)
      modelHandlers.set(modelId, handler)
    },
    registeredModels() {
      return Object.keys(modelBehaviors).sort()
    },
    async requests() {
      return history.map(copyCapturedRequest)
    },
    stop() {
      void server.stop()
    },
  }
}
