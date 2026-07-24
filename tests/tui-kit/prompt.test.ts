import { expect, test } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createChatView } from "../../packages/tui-kit/chat-view.ts"
import { createChatEditor } from "../../packages/tui-kit/editor.ts"
import { promptLine } from "../../packages/tui-kit/prompt.ts"

function emitKey(renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"], raw: string): void {
  const parsed = parseKeypress(raw)
  if (!parsed) throw new Error(`无法解析按键：${raw}`)
  renderer.keyInput.emit("keypress", new KeyEvent(parsed))
}

test("密钥输入只显示遮盖字符", async () => {
  const setup = await createTestRenderer({ width: 40, height: 5 })
  try {
    const pending = promptLine(setup.renderer, "secret", "API Key: ", { mask: true })
    emitKey(setup.renderer, "s")
    emitKey(setup.renderer, "k")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("API Key: ••")
    expect(setup.captureCharFrame()).not.toContain("sk")
    emitKey(setup.renderer, "\r")
    expect(await pending).toBe("sk")
  } finally {
    setup.renderer.destroy()
  }
})

test("认证输入可用 Esc 取消", async () => {
  const setup = await createTestRenderer({ width: 40, height: 5 })
  let cancelled = false
  try {
    const pending = promptLine(setup.renderer, "secret", "API Key: ", {
      mask: true,
      onCancel: () => {
        cancelled = true
      },
    })
    emitKey(setup.renderer, "\x1b")
    expect(await pending).toBe("")
    expect(cancelled).toBe(true)
  } finally {
    setup.renderer.destroy()
  }
})

test("聊天界面中的认证输入清晰可见", async () => {
  const setup = await createTestRenderer({ width: 80, height: 20 })
  try {
    createChatView(setup.renderer)
    const editor = createChatEditor(setup.renderer, {
      onSubmit: () => {},
      onAbort: () => {},
      onQuit: () => {},
    })
    editor.input.blur()
    const pending = promptLine(setup.renderer, "auth", "API 密钥：", { mask: true })
    emitKey(setup.renderer, "s")
    emitKey(setup.renderer, "k")
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("API 密钥：••")
    expect(frame).not.toContain("sk")

    emitKey(setup.renderer, "\r")
    expect(await pending).toBe("sk")
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("退出信号会取消正在等待的认证输入", async () => {
  const setup = await createTestRenderer({ width: 40, height: 5 })
  const controller = new AbortController()
  let cancelled = false
  try {
    const pending = promptLine(setup.renderer, "auth", "API 密钥：", {
      signal: controller.signal,
      onCancel: () => {
        cancelled = true
      },
    })
    controller.abort()
    expect(await pending).toBe("")
    expect(cancelled).toBe(true)
  } finally {
    setup.renderer.destroy()
  }
})
