import { expect, test } from "bun:test"
import { startMockServer } from "./mock-server.ts"

const expectedText = "架构门禁 CLI 端到端通过"

test("编译产物 --plain 模式对接 mock 并通过 pi provider 返回正确文本", async () => {
  const mock = startMockServer(expectedText)
  try {
    const proc = Bun.spawn({
      cmd: ["./dist/aizen-tui.exe", "--base-url", mock.url, "--api-key", "dummy", "--message", "hello"],
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
