import { expect, test } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createChatView } from "../../packages/tui-kit/chat-view.ts"
import { createChatEditor } from "../../packages/tui-kit/editor.ts"
import { selectItem } from "../../packages/tui-kit/selector.ts"

test("选择器可用 Esc 取消并清理界面", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  try {
    const pending = selectItem(setup.renderer, "selector", [{ name: "第一项", description: "说明", value: "first" }])
    const parsed = parseKeypress("\x1b")
    if (!parsed) throw new Error("无法解析 Esc")
    setup.renderer.keyInput.emit("keypress", new KeyEvent(parsed))
    expect(await pending).toBeUndefined()
    expect(setup.renderer.root.getRenderable("selector")).toBeUndefined()
  } finally {
    setup.renderer.destroy()
  }
})

test("聊天界面中的启动选择器清晰可见", async () => {
  const setup = await createTestRenderer({ width: 80, height: 20 })
  try {
    createChatView(setup.renderer)
    const editor = createChatEditor(setup.renderer, {
      onSubmit: () => {},
      onAbort: () => {},
      onQuit: () => {},
    })
    const pending = selectItem(setup.renderer, "provider-selector", [
      { name: "Anthropic", description: "需要 API 密钥", value: "anthropic" },
    ])
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Anthropic")
    expect(frame).toContain("需要 API 密钥")

    const parsed = parseKeypress("\x1b")
    if (!parsed) throw new Error("无法解析 Esc")
    setup.renderer.keyInput.emit("keypress", new KeyEvent(parsed))
    await pending
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})
