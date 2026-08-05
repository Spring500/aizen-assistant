import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { promptAuthInput } from "../../packages/tui-kit/auth-input.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

function emitKey(renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"], raw: string): void {
  const parsed = parseKeypress(raw)
  if (!parsed) throw new Error(`无法解析按键：${raw}`)
  renderer.keyInput.emit("keypress", new KeyEvent(parsed))
}

test("认证输入在认证页面内保持标题和说明可见", async () => {
  const setup = await createTestRenderer({ width: 60, height: 12 })
  try {
    const pending = promptAuthInput(setup.renderer, "auth", "Anthropic 认证", "API 密钥：", { mask: true })
    emitKey(setup.renderer, "s")
    emitKey(setup.renderer, "k")
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Anthropic 认证")
    expect(frame).toContain("输入内容仅以遮盖字符显示")
    expect(frame).toContain("API 密钥：••")
    expect(frame).not.toContain("sk")
    emitKey(setup.renderer, "\r")
    expect(await pending).toBe("sk")
  } finally {
    setup.renderer.destroy()
  }
})

test("认证文本输入支持原生左右光标", async () => {
  const setup = await createTestRenderer({ width: 60, height: 12 })
  try {
    const pending = promptAuthInput(setup.renderer, "auth-text", "AWS 认证", "配置名称：")
    emitKey(setup.renderer, "a")
    emitKey(setup.renderer, "c")
    emitKey(setup.renderer, "\x1b[D")
    emitKey(setup.renderer, "b")
    emitKey(setup.renderer, "\r")
    expect(await pending).toBe("abc")
  } finally {
    setup.renderer.destroy()
  }
})
