import type { MockBehavior, MockEvent, MockRequestContext } from "../types.ts"

function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function streamError(event: Extract<MockEvent, { type: "error" }>): Response {
  return Response.json(event.body ?? { error: { message: event.message } }, { status: event.status })
}

/** 将抽象事件流编码为 Anthropic Messages 协议的 SSE 响应。 */
export function encodeAnthropicEvents(
  events: AsyncIterable<MockEvent>,
  context: Pick<MockRequestContext, "signal"> & { modelId?: string },
): Response {
  const iterator = events[Symbol.asyncIterator]()
  let started = false
  let blockIndex = 0
  let outputTokens = 0
  const id = `msg_${crypto.randomUUID()}`
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) {
          if (started) {
            controller.enqueue(
              sseEvent("message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: outputTokens || 1 },
              }),
            )
            controller.enqueue(sseEvent("message_stop", { type: "message_stop" }))
          }
          controller.close()
          return
        }
        const event = next.value
        if (event.type === "error") {
          if (started) throw new Error("Mock error 事件必须是流中第一个事件")
          controller.error(streamError(event))
          return
        }
        if (!started) {
          started = true
          controller.enqueue(
            sseEvent("message_start", {
              type: "message_start",
              message: {
                id,
                type: "message",
                role: "assistant",
                content: [],
                model: context.modelId ?? "mock-model",
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            }),
          )
        }
        if (event.type === "thinking") {
          const index = blockIndex++
          controller.enqueue(
            sseEvent("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "thinking", thinking: "" },
            }),
          )
          controller.enqueue(
            sseEvent("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: event.text },
            }),
          )
          controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index }))
        } else if (event.type === "text") {
          const index = blockIndex++
          controller.enqueue(
            sseEvent("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "text", text: "" },
            }),
          )
          controller.enqueue(
            sseEvent("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: event.text },
            }),
          )
          controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index }))
        } else if (event.type === "tool") {
          const index = blockIndex++
          controller.enqueue(
            sseEvent("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "tool_use", id: event.callId, name: event.name, input: {} },
            }),
          )
          controller.enqueue(
            sseEvent("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(event.arguments) },
            }),
          )
          controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index }))
        } else if (event.type === "finish") {
          outputTokens = event.outputTokens ?? outputTokens
          controller.enqueue(
            sseEvent("message_delta", {
              type: "message_delta",
              delta: { stop_reason: event.reason === "toolUse" ? "tool_use" : "end_turn", stop_sequence: null },
              usage: { output_tokens: outputTokens || 1 },
            }),
          )
          controller.enqueue(sseEvent("message_stop", { type: "message_stop" }))
          controller.close()
          await iterator.return?.()
        }
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await iterator.return?.()
    },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

/** 将兼容用的单次处理器转换为 Mock 行为模块。 */
export function responseBehavior(
  handler: (context: MockRequestContext) => Promise<MockEvent[]>,
): MockBehavior {
  return async function* (context) {
    for (const event of await handler(context)) yield event
  }
}
