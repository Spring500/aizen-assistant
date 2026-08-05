import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { selectMultiple } from "../../packages/tui-kit/multi-select.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

function key(sequence: string): KeyEvent {
  const parsed = parseKeypress(sequence)
  if (!parsed) throw new Error("无法解析按键")
  return new KeyEvent(parsed)
}

test("多选框允许切换可用模态并保留禁用提示", async () => {
  const setup = await createTestRenderer({ width: 70, height: 20 })
  try {
    const pending = selectMultiple(setup.renderer, "modalities", "输入模态", [
      { value: "text", label: "文本", selected: true },
      { value: "pdf", label: "PDF", selected: false, disabled: true, disabledReason: "当前 pi adapter 不支持" },
      { value: "image", label: "图片", selected: false },
    ])
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("[-] PDF  当前 pi adapter 不支持")

    setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
    setup.renderer.keyInput.emit("keypress", key(" "))
    setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
    setup.renderer.keyInput.emit("keypress", key(" "))
    setup.renderer.keyInput.emit("keypress", key("\r"))
    expect(await pending).toEqual(["text", "image"])
  } finally {
    setup.renderer.destroy()
  }
})
