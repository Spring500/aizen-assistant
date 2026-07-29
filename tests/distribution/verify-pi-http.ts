// 分发验证：在无 Node/Bun 的 PATH 下确认独立探针能加载 pi 并完成流式 HTTP 请求。

import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startMockServer } from "../utils/mock-server.ts"

const source = "dist/pi-http-probe.exe"
if (!existsSync(source)) throw new Error(`产物不存在：${source}`)
const sandbox = join(tmpdir(), `aizen-pi-probe-${randomUUID()}`)
mkdirSync(sandbox)
const executable = join(sandbox, "pi-http-probe.exe")
copyFileSync(source, executable)
const expected = "pi HTTP 单文件探针通过"
const mock = await startMockServer(expected)
try {
  const systemRoot = globalThis.process.env.SystemRoot ?? "C:\\Windows"
  const child = Bun.spawn({
    cmd: [executable, mock.url],
    env: { PATH: `${systemRoot}\\System32`, SystemRoot: systemRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0 || stdout !== expected)
    throw new Error(`探针失败：exit=${exitCode} stdout=${stdout} stderr=${stderr}`)
  if (readdirSync(sandbox).join(",") !== "pi-http-probe.exe") throw new Error("探针依赖同目录附加文件")
  console.log("pi HTTP 单文件运行验证通过")
} finally {
  mock.stop()
  rmSync(sandbox, { recursive: true, force: true })
}
