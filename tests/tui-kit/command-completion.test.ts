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

test("超过五个命令时候选窗口跟随选中项滚动", async () => {
  const setup = await createTestRenderer({ width: 60, height: 18 })
  try {
    const editor = createChatEditor(
      setup.renderer,
      { onSubmit: () => {}, onAbort: () => {}, onQuit: () => {} },
      undefined,
      [
        { name: "/one", description: "命令一" },
        { name: "/two", description: "命令二" },
        { name: "/three", description: "命令三" },
        { name: "/four", description: "命令四" },
        { name: "/five", description: "命令五" },
        { name: "/six", description: "命令六" },
        { name: "/seven", description: "命令七" },
        { name: "/eight", description: "命令八" },
      ],
    )
    editor.input.setText("/")
    await Bun.sleep(1)
    for (let index = 0; index < 6; index += 1) emitKey(setup.renderer, "\x1b[B")
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("▶ /seven")
    expect(frame).toContain("/six")
    expect(frame).not.toContain("/one")
    emitKey(setup.renderer, "\t")
    expect(editor.input.plainText).toBe("/seven")
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("命令候选尽可能让选中项居中并在首尾收敛", async () => {
  const setup = await createTestRenderer({ width: 60, height: 18 })
  try {
    const editor = createChatEditor(
      setup.renderer,
      { onSubmit: () => {}, onAbort: () => {}, onQuit: () => {} },
      undefined,
      [
        { name: "/one", description: "命令一" },
        { name: "/two", description: "命令二" },
        { name: "/three", description: "命令三" },
        { name: "/four", description: "命令四" },
        { name: "/five", description: "命令五" },
        { name: "/six", description: "命令六" },
        { name: "/seven", description: "命令七" },
        { name: "/eight", description: "命令八" },
      ],
    )
    editor.input.setText("/")
    await Bun.sleep(1)
    for (let index = 0; index < 4; index += 1) emitKey(setup.renderer, "\x1b[B")
    await setup.renderOnce()
    const centered = setup.captureCharFrame()
    expect(centered).toContain("/three")
    expect(centered).toContain("▶ /five")
    expect(centered).toContain("/seven")
    expect(centered).not.toContain("/two")
    expect(centered).not.toContain("/eight")

    for (let index = 0; index < 3; index += 1) emitKey(setup.renderer, "\x1b[B")
    await setup.renderOnce()
    const atEnd = setup.captureCharFrame()
    expect(atEnd).toContain("/four")
    expect(atEnd).toContain("▶ /eight")
    expect(atEnd).not.toContain("/three")
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("矮终端优先保留状态、快捷键和错误行", async () => {
  const setup = await createTestRenderer({ width: 60, height: 9, screenMode: "split-footer", footerHeight: 8 })
  try {
    const editor = createChatEditor(
      setup.renderer,
      { onSubmit: () => {}, onAbort: () => {}, onQuit: () => {} },
      undefined,
      commands,
    )
    editor.setStatus("模型状态必须可见")
    editor.setShortcuts("快捷键状态必须可见")
    editor.setError("错误状态必须可见")
    editor.input.setText("/")
    await Bun.sleep(1)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("模型状态必须可见")
    expect(frame).toContain("快捷键状态必须可见")
    expect(frame).toContain("错误状态必须可见")
    expect(setup.renderer.footerHeight).toBeLessThanOrEqual(setup.renderer.terminalHeight)
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
