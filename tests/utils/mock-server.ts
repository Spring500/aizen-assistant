export type MockServer = {
  url: string
  stop: () => void
}

/**
 * 在独立的 Worker 线程里启动 mock HTTP server，模拟 Anthropic Messages API
 * 的 SSE 响应。供架构可行性验证和 CLI 契约测试复用，避免各处重复实现同一
 * 套 mock 逻辑。
 *
 * 为什么放进 Worker，而不是直接在调用方所在的线程里用 Bun.serve 起服务：
 * 调用方往往需要用 Bun.spawn 去跑被测的编译产物。若改用同步阻塞调用（如
 * Bun.spawnSync），会冻住调用方所在线程的整个事件循环——如果 mock
 * server 也跑在那个线程上，一阻塞，mock server 的请求回调就没有机会
 * 执行，子进程的 HTTP 请求永远等不到响应，父进程又要等子进程退出才能
 * 解除阻塞，构成死锁（父等子、子等父）。
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
