// 分发验证：将产物复制到空白目录，并在没有 Node/Bun 的 PATH 下确认它能独立启动。
// 用法：bun run tests/distribution/verify-tui.ts [产物路径]（默认 dist/aizen-assistant.exe）

import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { removeTemporaryDirectory } from "../utils/temporary-directory.ts"

const exePath = process.argv[2] ?? "dist/aizen-assistant.exe"
if (!existsSync(exePath)) {
  console.error(`产物不存在：${exePath}`)
  process.exit(1)
}

const sandbox = join(tmpdir(), `aizen-assistant-${randomUUID()}`)
mkdirSync(sandbox)
const executableName = basename(exePath)
const executable = join(sandbox, executableName)
copyFileSync(exePath, executable)

try {
  // 用最小 PATH 启动，确认产物不依赖 Node/Bun 等外部运行时
  const env =
    process.platform === "win32"
      ? {
          PATH: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`,
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        }
      : { PATH: "/usr/bin:/bin" }
  const proc = Bun.spawn({
    cmd: [executable, "--unknown"],
    env,
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
  if (files.length !== 1 || files[0] !== executableName) {
    console.error("产物依赖同目录附加文件")
    process.exit(1)
  }

  console.log("单文件无外部运行时启动验证通过")
} finally {
  await removeTemporaryDirectory(sandbox)
}
