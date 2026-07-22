// 本文件运行在独立的 Worker 线程里（由 mock-server.ts 的 startMockServer
// 创建），不与调用方共享事件循环。见 mock-server.ts 顶部注释说明原因。
//
// 这里只处理主线程与本 worker 之间的启动/关闭协议，实际的 mock 响应
// 逻辑（怎么拼 SSE 报文、怎么起 HTTP server）在 mock-server.ts 里的
// createMockAnthropicServer，两边职责分开、各自都能被完整类型检查。
import { createMockAnthropicServer } from "./mock-server.ts"

type StartMessage = { type: "start"; responseText: string }
type StopMessage = { type: "stop" }
type IncomingMessage = StartMessage | StopMessage

/** 当前 worker 里跑着的 HTTP server；`undefined` 表示还没收到 "start" 消息。 */
let server: ReturnType<typeof createMockAnthropicServer> | undefined

/**
 * 处理来自主线程的两种消息：
 * - "start"：启动 mock server，把监听到的地址回传给主线程。
 * - "stop"：优雅关闭 server（等待在途请求处理完），然后退出本 worker 进程。
 */
globalThis.addEventListener("message", async (event: MessageEvent<IncomingMessage>) => {
  const message = event.data

  if (message.type === "start" && !server) {
    server = createMockAnthropicServer(message.responseText)
    postMessage({ type: "listening", url: `http://localhost:${server.port}` })
    return
  }

  if (message.type === "stop" && server) {
    // 优雅关闭：等待正在处理的请求完成，而不是直接砍断连接。
    await server.stop()
    process.exit(0)
  }
})
