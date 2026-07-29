import { expect, test } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { editInline } from "../../packages/tui-kit/inline-input.ts"
import { OverlayManager } from "../../packages/tui-kit/overlay-manager.ts"

function key(sequence: string): KeyEvent {
  const parsed = parseKeypress(sequence)
  if (!parsed) throw new Error("无法解析按键")
  return new KeyEvent(parsed)
}

test("行内输入使用原生光标移动且不会写入方向键转义字符", async () => {
  const setup = await createTestRenderer({ width: 50, height: 12 })
  const overlays = new OverlayManager(setup.renderer)
  try {
    const handle = overlays.open({ id: "inline", title: "字段编辑", contentHeight: 3 })
    const pending = editInline(overlays, handle, {
      id: "name",
      label: "名称  ",
      initialValue: "ac",
      top: 1,
    })
    setup.renderer.keyInput.emit("keypress", key("\x1b[D"))
    setup.renderer.keyInput.emit("keypress", key("b"))
    setup.renderer.keyInput.emit("keypress", key("\r"))
    expect(await pending).toBe("abc")
    expect(setup.captureCharFrame()).not.toContain("[D")
    handle.close()
  } finally {
    overlays.dispose()
    setup.renderer.destroy()
  }
})

test("行内输入取消时不返回修改内容", async () => {
  const setup = await createTestRenderer({ width: 50, height: 12 })
  const overlays = new OverlayManager(setup.renderer)
  try {
    const handle = overlays.open({ id: "inline-cancel", title: "字段编辑", contentHeight: 2 })
    const pending = editInline(overlays, handle, {
      id: "path",
      label: "路径  ",
      initialValue: "E:\\view",
    })
    setup.renderer.keyInput.emit("keypress", key("\x1b"))
    expect(await pending).toBeUndefined()
    handle.close()
  } finally {
    overlays.dispose()
    setup.renderer.destroy()
  }
})
