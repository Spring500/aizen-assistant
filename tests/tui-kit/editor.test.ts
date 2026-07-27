import { expect, test } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createChatEditor, shortcutText } from "../../packages/tui-kit/editor.ts"

function emitKey(renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"], raw: string): void {
  const parsed = parseKeypress(raw)
  if (!parsed) throw new Error(`无法解析按键：${raw}`)
  renderer.keyInput.emit("keypress", new KeyEvent(parsed))
}

test("编辑器发送、中止和忙碌状态", async () => {
  const setup = await createTestRenderer({ width: 60, height: 8 })
  const submitted: string[] = []
  let aborted = 0
  try {
    const editor = createChatEditor(setup.renderer, {
      onSubmit: (value) => submitted.push(value),
      onAbort: () => aborted++,
      onQuit: () => {},
    })
    editor.input.setText("第一条")
    editor.input.submit()
    expect(submitted).toEqual(["第一条"])
    editor.setBusy(true)
    editor.input.setText("第二条")
    editor.input.submit()
    expect(submitted).toEqual(["第一条"])
    emitKey(setup.renderer, "\x1b")
    expect(aborted).toBe(1)
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("编辑器支持反斜杠回车换行，并用 Enter 发送", async () => {
  const setup = await createTestRenderer({ width: 80, height: 10 })
  const submitted: string[] = []
  try {
    const editor = createChatEditor(setup.renderer, {
      onSubmit: (value) => submitted.push(value),
      onAbort: () => {},
      onQuit: () => {},
    })
    editor.input.setText("第一行\\")
    editor.input.submit()
    expect(submitted).toEqual([])
    expect(editor.input.plainText).toBe("第一行\n")
    editor.input.setText(`${editor.input.plainText}第二行`)
    editor.input.submit()
    expect(submitted).toEqual(["第一行\n第二行"])
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("编辑器可在选择和认证期间隐藏", async () => {
  const setup = await createTestRenderer({ width: 60, height: 8 })
  try {
    const editor = createChatEditor(setup.renderer, {
      onSubmit: () => {},
      onAbort: () => {},
      onQuit: () => {},
    })
    editor.setVisible(false)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("输入消息")
    expect(setup.captureCharFrame()).not.toContain("模型：")
    editor.setVisible(true)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("输入消息")
    expect(setup.captureCharFrame()).toContain("模型：未选择模型")
    expect(setup.captureCharFrame()).toContain("Shift+Enter 或 \\+Enter 换行")

    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("快捷键提示随状态变化", () => {
  expect(shortcutText({ status: "running", hasSession: true })).toContain("Esc 中止")
  expect(shortcutText({ status: "idle", hasSession: true })).toContain("Shift+Enter 或 \\+Enter 换行")
  expect(shortcutText({ status: "idle", hasSession: false })).toContain("↑/↓ 选择")
})
