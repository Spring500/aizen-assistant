export type MockServer = {
  url: string
  stop: () => void
}

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

/**
 * 启动一个监听随机端口的 HTTP server，把自己伪装成 Anthropic Messages
 * API：收到 `POST /v1/messages` 就回一段固定内容的 SSE 响应，其余请求
 * 返回 404。供 `mock-server-worker.ts` 在 worker 线程里调用。
 */
export function createMockAnthropicServer(responseText: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return new Response(buildSseBody(responseText), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
}

/**
 * 在独立的 Worker 线程里启动上面的 mock server。供架构可行性验证和 CLI
 * 契约测试复用，避免各处重复实现同一套 mock 逻辑。
 *
 * 为什么放进 Worker，而不是直接在调用方所在的线程里调用
 * createMockAnthropicServer：调用方往往需要用 Bun.spawn 去跑被测的编译
 * 产物。若改用同步阻塞调用（如 Bun.spawnSync），会冻住调用方所在线程的
 * 整个事件循环——如果 mock server 也跑在那个线程上，一阻塞，mock
 * server 的请求回调就没有机会执行，子进程的 HTTP 请求永远等不到响应，
 * 父进程又要等子进程退出才能解除阻塞，构成死锁（父等子、子等父）。
 *
 * 把 mock server 放进独立 Worker 线程后，它有自己独立的事件循环，不会被
 * 主线程上任何同步阻塞调用拖累——不只是 spawnSync，未来任何测试代码里的
 * 同步阻塞都一样安全。这是结构上的保证，不依赖调用方记住某条约定。
 */
export async function startMockServer(responseText: string): Promise<MockServer> {
  const worker = new Worker(new URL("./mock-server-worker.ts", import.meta.url))

  // 等 worker 内部的 Bun.serve 真正开始监听后，再把端口号交给调用方——
  // 调用方拿到 url 时，mock server 保证已经可以接收请求。
  const url = await new Promise<string>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ type: string; url?: string }>) => {
      if (event.data?.type === "listening" && event.data.url) {
        resolve(event.data.url)
      }
    }
    worker.onerror = (event) => {
      reject(new Error(`mock server worker 启动失败：${event.message ?? String(event)}`))
    }
    worker.postMessage({ type: "start", responseText })
  })

  return {
    url,
    stop: () => {
      // 通知 worker 内部优雅关闭（等待在途请求完成，见 mock-server-worker.ts）。
      worker.postMessage({ type: "stop" })
      // 安全网：Bun 的 Worker 终止机制仍是实验特性（官方文档标注），若
      // worker 未能在合理时间内自行退出，强制终止，避免测试进程挂起。
      const forceTimeout = setTimeout(() => worker.terminate(), 2000)
      worker.addEventListener("close", () => clearTimeout(forceTimeout))
    },
  }
}

// 手动验证用的入口：直接用 bun run 跑这个文件时执行，被其他文件 import
// 时不会触发。启动一个 mock server 并常驻，方便人工在真实终端里测试
// aizen-tui.exe（非交互模式或交互模式），不需要真实的 Anthropic API Key。
// 用法：bun run tests/utils/mock-server.ts "自定义响应文本"
if (import.meta.main) {
  const text = process.argv[2] ?? "架构可行性验证：Mock 链路通过"
  const mock = await startMockServer(text)
  console.log(`Mock server 已启动：${mock.url}`)
  console.log(`响应内容：${text}`)
  console.log("按 Ctrl+C 停止")
}
