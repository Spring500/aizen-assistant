import type { MockEvent, MockRequestContext } from "../types.ts"

function sseData(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)
}

/** 将抽象事件流编码为 OpenAI Chat Completions 协议的 SSE 响应。 */
export function encodeOpenAiEvents(
  events: AsyncIterable<MockEvent>,
  context: Pick<MockRequestContext, "modelId">,
): Response {
  const iterator = events[Symbol.asyncIterator]()
  const id = `chatcmpl_${crypto.randomUUID()}`
  let started = false
  let finished = false
  let toolIndex = 0
  const chunk = (
    delta: Record<string, unknown>,
    finishReason: string | null = null,
    usage?: Record<string, number>,
  ) => ({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: context.modelId ?? "mock-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) {
          if (!finished)
            controller.enqueue(sseData(chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })))
          controller.enqueue(sseData("[DONE]"))
          controller.close()
          return
        }
        const event = next.value
        if (event.type === "error") throw new Error("Mock error 事件必须是流中第一个事件")
        if (!started) {
          started = true
          controller.enqueue(sseData(chunk({ role: "assistant" })))
        }
        if (event.type === "thinking") {
          controller.enqueue(sseData(chunk({ reasoning_content: event.text })))
        } else if (event.type === "text") {
          controller.enqueue(sseData(chunk({ content: event.text })))
        } else if (event.type === "tool") {
          const index = toolIndex++
          controller.enqueue(
            sseData(
              chunk({
                tool_calls: [
                  {
                    index: index,
                    id: event.callId,
                    type: "function",
                    function: { name: event.name, arguments: JSON.stringify(event.arguments) },
                  },
                ],
              }),
            ),
          )
        } else if (event.type === "finish") {
          finished = true
          const outputTokens = event.outputTokens ?? 1
          controller.enqueue(
            sseData(
              chunk({}, event.reason === "toolUse" ? "tool_calls" : "stop", {
                prompt_tokens: event.inputTokens ?? 1,
                completion_tokens: outputTokens,
                total_tokens: (event.inputTokens ?? 1) + outputTokens,
              }),
            ),
          )
          controller.enqueue(sseData("[DONE]"))
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
