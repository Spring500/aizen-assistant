import { expect, test } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createChatEditor } from "../../packages/tui-kit/editor.ts"

function emitKey(renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"], raw: string): void {
  const parsed = parseKeypress(raw)
  if (!parsed) throw new Error(`无法解析按键：${raw}`)
  renderer.keyInput.emit("keypress", new KeyEvent(parsed))
}

const commands = [
  { name: "/new", description: "新建会话" },
  { name: "/model", description: "切换模型" },
  { name: "/models", description: "管理模型" },
] as const

test("首个有效字符为斜杠时显示并过滤命令候选", async () => {
  const setup = await createTestRenderer({ width: 60, height: 16 })
  try {
    const editor = createChatEditor(
      setup.renderer,
      { onSubmit: () => {}, onAbort: () => {}, onQuit: () => {} },
      undefined,
      commands,
    )
    editor.input.setText("  /mo")
    await Bun.sleep(1)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("/model")
    expect(frame).toContain("切换模型")
    expect(frame).toContain("/models")
    expect(frame).not.toContain("/new     新建会话")
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("正文或命令参数中的斜杠不触发候选", async () => {
  const setup = await createTestRenderer({ width: 60, height: 14 })
  try {
    const editor = createChatEditor(
      setup.renderer,
      { onSubmit: () => {}, onAbort: () => {}, onQuit: () => {} },
      undefined,
      commands,
    )
    for (const value of ["路径 a/b", "第一段\n/new", "/new 参数"]) {
      editor.input.setText(value)
      await Bun.sleep(1)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).not.toContain("新建会话")
    }
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("Enter 和 Tab 只补全命令且必须再次 Enter 才执行", async () => {
  const setup = await createTestRenderer({ width: 60, height: 14 })
  const submitted: string[] = []
  try {
    const editor = createChatEditor(
      setup.renderer,
      { onSubmit: (value) => submitted.push(value), onAbort: () => {}, onQuit: () => {} },
      undefined,
      commands,
    )
    editor.input.setText("/n")
    await Bun.sleep(1)
    editor.input.submit()
    expect(editor.input.plainText).toBe("/new")
    expect(submitted).toEqual([])
    editor.input.submit()
    expect(submitted).toEqual(["/new"])

    editor.input.setText("/mo")
    await Bun.sleep(1)
    emitKey(setup.renderer, "\t")
    expect(editor.input.plainText).toBe("/model")
    expect(submitted).toEqual(["/new"])
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("上下键切换候选且 Esc 关闭后保留输入", async () => {
  const setup = await createTestRenderer({ width: 60, height: 14 })
  let aborted = 0
  try {
    const editor = createChatEditor(
      setup.renderer,
      { onSubmit: () => {}, onAbort: () => aborted++, onQuit: () => {} },
      undefined,
      commands,
    )
    editor.input.setText("/")
    await Bun.sleep(1)
    emitKey(setup.renderer, "\x1b[B")
    emitKey(setup.renderer, "\t")
    expect(editor.input.plainText).toBe("/model")

    editor.input.setText("/")
    await Bun.sleep(1)
    emitKey(setup.renderer, "\x1b")
    expect(editor.input.plainText).toBe("/")
    expect(aborted).toBe(0)
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})
