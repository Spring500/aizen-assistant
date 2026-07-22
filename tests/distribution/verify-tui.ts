import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startMockServer } from "../contract/mock-server.ts"

const exePath = "dist/aizen-tui.exe"
if (!existsSync(exePath)) {
  console.error(`产物不存在：${exePath}`)
  process.exit(1)
}

const sandbox = join(tmpdir(), `aizen-tui-${randomUUID()}`)
mkdirSync(sandbox)
const executable = join(sandbox, "aizen-tui.exe")
copyFileSync(exePath, executable)

const mockResponseText = "分发验证：单文件无外部运行时"
const mock = startMockServer(mockResponseText)

try {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
  // 必须用 Bun.spawn（异步），不能用 Bun.spawnSync。
  // spawnSync 会同步阻塞本进程的整个 JS 主线程；本进程同时用 Bun.serve
  // 跑着上面的 mock server，一旦阻塞，mock server 的请求回调就没有机会
  // 执行——子进程发出的 HTTP 请求永远等不到响应，父进程又要等子进程退出
  // 才能解除阻塞，形成死锁（父等子、子等父）。已实测验证：换成
  // spawnSync 会在本地和 CI 上永久挂起，与 Windows/Bun 版本无关，是单
  // 线程事件循环下的必然结果，不是 Bun 的缺陷。详见 REVIEW_PLAN 缺陷 9。
  const proc = Bun.spawn({
    cmd: [executable, "--base-url", mock.url, "--api-key", "dummy", "--message", "hello"],
    env: { PATH: `${systemRoot}\\System32`, SystemRoot: systemRoot },
    stdin: "ignore",
  })
  const exitCode = await proc.exited
  const stdout = (await new Response(proc.stdout).text()).trim()
  const stderr = await new Response(proc.stderr).text()

  if (exitCode !== 0) {
    console.error(`自检失败：exit=${exitCode} stderr=${stderr}`)
    process.exit(1)
  }

  if (stdout !== mockResponseText) {
    console.error(`输出不匹配，期望 "${mockResponseText}"，实际 "${stdout}"`)
    process.exit(1)
  }

  const files = readdirSync(sandbox)
  if (files.length !== 1 || files[0] !== "aizen-tui.exe") {
    console.error("产物依赖同目录附加文件")
    process.exit(1)
  }

  console.log("单文件无外部运行时验证通过")
} finally {
  mock.stop()
  rmSync(sandbox, { recursive: true, force: true })
}
