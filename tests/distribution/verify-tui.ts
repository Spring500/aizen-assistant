// 分发验证：将产物复制到空白目录，并在没有 Node/Bun 的 PATH 下确认它能独立启动。

import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const exePath = "dist/aizen-tui.exe"
if (!existsSync(exePath)) {
  console.error(`产物不存在：${exePath}`)
  process.exit(1)
}

const sandbox = join(tmpdir(), `aizen-tui-${randomUUID()}`)
mkdirSync(sandbox)
const executable = join(sandbox, "aizen-tui.exe")
copyFileSync(exePath, executable)

try {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
  const proc = Bun.spawn({
    cmd: [executable, "--unknown"],
    env: { PATH: `${systemRoot}\\System32`, SystemRoot: systemRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  const stderr = await new Response(proc.stderr).text()

  if (exitCode !== 2 || !stderr.includes("用法")) {
    console.error(`自检失败：exit=${exitCode} stderr=${stderr}`)
    process.exit(1)
  }

  const files = readdirSync(sandbox)
  if (files.length !== 1 || files[0] !== "aizen-tui.exe") {
    console.error("产物依赖同目录附加文件")
    process.exit(1)
  }

  console.log("单文件无外部运行时启动验证通过")
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
