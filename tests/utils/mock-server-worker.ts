// 本文件运行在独立的 Worker 线程里（由 mock-server.ts 的 startMockServer
// 创建），不与调用方共享事件循环。见 mock-server.ts 顶部注释说明原因。

type StartMessage = { type: "start"; responseText: string }
type StopMessage = { type: "stop" }
type IncomingMessage = StartMessage | StopMessage

/**
 * 拼出一段符合 Anthropic Messages API 流式响应格式（SSE）的报文，内容
 * 固定只有一段文本 `responseText`。字段结构模拟真实 API 的
 * message_start → content_block_* → message_delta → message_stop
 * 事件序列，让 pi 的 HTTP 客户端能像对接真实 API 一样把它解析出来。
 */
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

/** 当前 worker 里跑着的 HTTP server；`undefined` 表示还没收到 "start" 消息。 */
let server: ReturnType<typeof Bun.serve> | undefined

/**
 * 处理来自主线程的两种消息：
 * - "start"：启动 Bun.serve，监听一个随机端口，把监听到的地址回传给主线程。
 * - "stop"：优雅关闭 server（等待在途请求处理完），然后退出本 worker 进程。
 */
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
