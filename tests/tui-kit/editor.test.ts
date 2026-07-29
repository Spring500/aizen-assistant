import { expect, test } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createChatEditor } from "../../packages/tui-kit/editor.ts"
import { shortcutText } from "../../packages/tui-kit/status-bar.ts"

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

test("编辑器支持光标前反斜杠回车换行，并用 Enter 发送", async () => {
  const setup = await createTestRenderer({ width: 80, height: 10 })
  const submitted: string[] = []
  try {
    const editor = createChatEditor(setup.renderer, {
      onSubmit: (value) => submitted.push(value),
      onAbort: () => {},
      onQuit: () => {},
    })
    editor.input.setText("first\\")
    editor.input.cursorOffset = editor.input.plainText.length
    editor.input.submit()
    expect(submitted).toEqual([])
    expect(editor.input.plainText).toBe("first\n")
    expect(editor.input.logicalCursor).toMatchObject({ row: 1, col: 0 })

    editor.input.setText("first\nabc\\def")
    editor.input.cursorOffset = "first\nabc\\".length
    editor.input.submit()
    expect(editor.input.plainText).toBe("first\nabc\ndef")
    expect(editor.input.logicalCursor).toMatchObject({ row: 2, col: 0 })

    editor.input.submit()
    expect(submitted).toEqual(["first\nabc\ndef"])
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("编辑器可只隐藏输入框并保持底部状态栏可见", async () => {
  const setup = await createTestRenderer({ width: 120, height: 8 })
  try {
    const editor = createChatEditor(setup.renderer, {
      onSubmit: () => {},
      onAbort: () => {},
      onQuit: () => {},
    })
    editor.setShortcuts(shortcutText({ status: "idle", hasSession: true }))
    editor.setInputVisible(false)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("输入消息")
    expect(setup.captureCharFrame()).toContain("模型：未选择模型")
    expect(setup.captureCharFrame()).toContain("光标前 \\ 后 Enter 换行")
    editor.setInputVisible(true)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("输入消息")
    expect(setup.captureCharFrame()).toContain("模型：未选择模型")
    expect(setup.captureCharFrame()).toContain("光标前 \\ 后 Enter 换行")

    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("编辑器高度随视觉行数变化并显示带标题分割线", async () => {
  const setup = await createTestRenderer({
    width: 40,
    height: 16,
    screenMode: "split-footer",
    footerHeight: 9,
  })
  try {
    const editor = createChatEditor(setup.renderer, {
      onSubmit: () => {},
      onAbort: () => {},
      onQuit: () => {},
    })
    editor.setSessionTitle({ name: "修复登录重试", sessionId: "otter-builds-bridge" })
    editor.input.setText("第一行\n第二行\n第三行")
    await Bun.sleep(1)
    await setup.renderOnce()
    expect(editor.input.height).toBe(3)
    expect(setup.renderer.footerHeight).toBe(11)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("修复登录重试  otter-builds-bridge──")
    expect(frame).toContain("第一行")
    expect(frame).toContain("第三行")

    editor.input.setText(Array.from({ length: 12 }, (_, index) => `第 ${index} 行`).join("\n"))
    for (let attempt = 0; attempt < 20 && editor.input.height !== 8; attempt += 1) await Bun.sleep(5)
    expect(editor.input.height).toBe(8)
    expect(setup.renderer.footerHeight).toBe(16)
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("没有会话名时标题只显示会话 ID", async () => {
  const setup = await createTestRenderer({ width: 40, height: 12 })
  try {
    const editor = createChatEditor(setup.renderer, {
      onSubmit: () => {},
      onAbort: () => {},
      onQuit: () => {},
    })
    editor.setSessionTitle({ name: "", sessionId: "owl-carries-brook" })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("owl-carries-brook──")
    expect(frame).not.toContain("会话──")
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("快捷键提示随状态变化", () => {
  expect(shortcutText({ status: "running", hasSession: true })).toContain("Esc 中止")
  expect(shortcutText({ status: "idle", hasSession: true })).toContain("光标前 \\ 后 Enter 换行")
  expect(shortcutText({ status: "idle", hasSession: false })).toContain("↑/↓ 选择")
})
