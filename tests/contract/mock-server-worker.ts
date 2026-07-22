type StartMessage = { type: "start"; responseText: string }
type StopMessage = { type: "stop" }
type IncomingMessage = StartMessage | StopMessage

function buildSseBody(responseText: string): string {
  const id = `msg_${Date.now()}`
  let body = ""
  body += `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", content: [], model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`
  body += `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`
  body += `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: responseText } })}\n\n`
  body += `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`
  body += `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`
  body += `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
  return body
}

let server: ReturnType<typeof Bun.serve> | undefined

globalThis.addEventListener("message", async (event: MessageEvent<IncomingMessage>) => {
  const message = event.data

  if (message.type === "start" && !server) {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method === "POST" && url.pathname === "/v1/messages") {
          return new Response(buildSseBody(message.responseText), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    postMessage({ type: "listening", url: `http://localhost:${server.port}` })
    return
  }

  if (message.type === "stop" && server) {
    // 优雅关闭：等待正在处理的请求完成，而不是直接砍断连接。
    await server.stop()
    process.exit(0)
  }
})
