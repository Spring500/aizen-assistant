// 契约测试：验证编译产物 dist/aizen-tui.exe 对外的命令行参数契约
// （--plain 非交互模式、未带 --plain 时的用法报错）确实按预期工作，而不
// 是只验证 main.ts 的源码逻辑——这里跑的是真实编译出来的 exe。
import { expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { startMockServer } from "../utils/mock-server.ts"

const expectedText = "架构可行性验证：CLI 端到端通过"
const exePath = "./dist/aizen-tui.exe"
const sourcePaths = ["./apps/tui/main.ts", "./packages/pi-adapter/complete.ts", "./packages/tui-kit/interactive.ts"]

/**
 * 确认 dist/aizen-tui.exe 存在，且不早于它的任何源文件——避免开发者改了
 * 源码却忘记重新 bun run build:tui，导致这里测的是一份过期的编译产物，
 * 得出误报的"通过"。
 */
function ensureExeFresh(): void {
  if (!existsSync(exePath)) {
    throw new Error(`${exePath} 不存在，请先运行 bun run build:tui`)
  }
  const exeMtime = statSync(exePath).mtimeMs
  const staleSource = sourcePaths.find((path) => statSync(path).mtimeMs > exeMtime)
  if (staleSource) {
    throw new Error(`${exePath} 早于 ${staleSource}，请先重新运行 bun run build:tui`)
  }
}

test("编译产物 --plain 模式对接 mock 并通过 pi provider 返回正确文本", async () => {
  ensureExeFresh()

  const mock = await startMockServer(expectedText)
  try {
    // 用 Bun.spawn（异步）而非 Bun.spawnSync：mock server 已经跑在独立
    // Worker 线程里（见 mock-server.ts），本身不会被这里的同步阻塞影响；
    // 选异步纯粹是不阻塞本进程主线程的一般实践，非规避死锁的硬性要求。
    const proc = Bun.spawn({
      cmd: [exePath, "--plain", "--base-url", mock.url, "--api-key", "dummy", "--message", "hello"],
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    if (exitCode !== 0) {
      throw new Error(`exit=${exitCode} stderr=${stderr}`)
    }
    expect(stdout.trim()).toBe(expectedText)
  } finally {
    mock.stop()
  }
}, 30000)

test("编译产物：传了 --base-url 等参数但没带 --plain，报用法错误而不是静默进入非交互模式", async () => {
  ensureExeFresh()

  const proc = Bun.spawn({
    cmd: [exePath, "--base-url", "http://localhost:1", "--api-key", "dummy", "--message", "hello"],
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  const stderr = await new Response(proc.stderr).text()

  expect(exitCode).toBe(2)
  expect(stderr).toContain("用法")
}, 10000)
