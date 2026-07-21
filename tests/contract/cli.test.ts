import { expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { startMockServer } from "./mock-server.ts"

const expectedText = "架构门禁 CLI 端到端通过"
const exePath = "./dist/aizen-tui.exe"
const sourcePaths = ["./apps/tui/main.ts", "./packages/pi-adapter/complete.ts", "./packages/tui-kit/interactive.ts"]

test("编译产物非交互模式对接 mock 并通过 pi provider 返回正确文本", async () => {
  if (!existsSync(exePath)) {
    throw new Error(`${exePath} 不存在，请先运行 bun run build:tui`)
  }
  const exeMtime = statSync(exePath).mtimeMs
  const staleSource = sourcePaths.find((path) => statSync(path).mtimeMs > exeMtime)
  if (staleSource) {
    throw new Error(`${exePath} 早于 ${staleSource}，请先重新运行 bun run build:tui`)
  }

  const mock = startMockServer(expectedText)
  try {
    const proc = Bun.spawn({
      cmd: [exePath, "--base-url", mock.url, "--api-key", "dummy", "--message", "hello"],
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
