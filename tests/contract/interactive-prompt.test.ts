import { expect, test } from "bun:test"
import { KeyEvent, parseKeypress, PasteEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { promptLine } from "../../packages/tui-kit/interactive.ts"

function emitKey(renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"], raw: string): void {
  const parsed = parseKeypress(raw)
  if (!parsed) throw new Error(`无法解析按键序列：${JSON.stringify(raw)}`)
  renderer.keyInput.emit("keypress", new KeyEvent(parsed))
}

test("promptLine：逐字符输入、粘贴、Backspace 后按 Enter 返回正确内容", async () => {
  const setup = await createTestRenderer({ width: 48, height: 8 })
  try {
    const pending = promptLine(setup.renderer, "prompt-test", "Message: ")

    emitKey(setup.renderer, "a")
    emitKey(setup.renderer, "b")

    // 模拟终端粘贴：整块送达，且带一个换行（单行输入框应剔除换行）。
    setup.renderer.keyInput.emit("paste", new PasteEvent(new TextEncoder().encode("XY\n")))

    emitKey(setup.renderer, "\x7f") // Backspace，删掉粘贴内容的最后一个字符
    emitKey(setup.renderer, "\r") // Enter，提交

    const value = await pending
    expect(value).toBe("abX")
  } finally {
    setup.renderer.destroy()
  }
})

test("promptLine：mask 选项下屏幕只显示 • 不显示明文", async () => {
  const setup = await createTestRenderer({ width: 48, height: 8 })
  try {
    const pending = promptLine(setup.renderer, "prompt-mask-test", "API Key: ", { mask: true })

    emitKey(setup.renderer, "s")
    emitKey(setup.renderer, "k")
    emitKey(setup.renderer, "-")
    await setup.renderOnce()

    const frame = setup.captureCharFrame()
    expect(frame).toContain("API Key: •••")
    expect(frame).not.toContain("sk-")

    emitKey(setup.renderer, "\r")
    const value = await pending
    expect(value).toBe("sk-")
  } finally {
    setup.renderer.destroy()
  }
})
