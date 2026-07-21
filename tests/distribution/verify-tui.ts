import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

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
  const result = Bun.spawnSync({
    cmd: [executable, "--self-test"],
    env: { PATH: `${systemRoot}\\System32`, SystemRoot: systemRoot },
  })

  if (result.exitCode !== 0) {
    console.error("自检失败")
    process.exit(1)
  }

  const output = new TextDecoder().decode(result.stdout).trim()
  const lines = output.split(/\r?\n/)
  const lastLine = lines[lines.length - 1]
  if (!lastLine) {
    console.error("产物无输出")
    process.exit(1)
  }
  const report = JSON.parse(lastLine)
  if (!report.passed) {
    console.error("存在失败检查")
    process.exit(1)
  }

  const { readdirSync } = await import("node:fs")
  const files = readdirSync(sandbox)
  if (files.length !== 1 || files[0] !== "aizen-tui.exe") {
    console.error("产物依赖同目录附加文件")
    process.exit(1)
  }

  console.log("单文件无外部运行时验证通过")
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
