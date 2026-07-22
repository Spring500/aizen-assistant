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
const mock = await startMockServer(mockResponseText)

try {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
  // 用 Bun.spawn（异步）而非 Bun.spawnSync：mock server 已经跑在独立
  // Worker 线程里（见 mock-server.ts），本身不会被这里的同步阻塞影响；
  // 选异步纯粹是不阻塞本进程主线程的一般实践，非规避死锁的硬性要求。
  const proc = Bun.spawn({
    cmd: [executable, "--plain", "--base-url", mock.url, "--api-key", "dummy", "--message", "hello"],
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
