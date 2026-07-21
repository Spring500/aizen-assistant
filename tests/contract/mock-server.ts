export type MockServer = {
  url: string
  stop: () => void
}

export function startMockServer(responseText: string): MockServer {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        const id = `msg_${Date.now()}`

        const encoder = new TextEncoder()
        let body = ""
        const usageOutputTokens = 1
        body += `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", content: [], model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: usageOutputTokens } } })}\n\n`
        body += `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`
        body += `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: responseText } })}\n\n`
        body += `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`
        body += `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usageOutputTokens } })}\n\n`
        body += `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`

        return new Response(encoder.encode(body), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })

  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(),
  }
}
