import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createChatEditor } from "../../packages/tui-kit/editor.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

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
    const editor = createChatEditor(setup.renderer, { onSubmit: () => {}, onAbort: () => {}, onQuit: () => {} }, [
      { name: "/one", description: "命令一" },
      { name: "/two", description: "命令二" },
      { name: "/three", description: "命令三" },
      { name: "/four", description: "命令四" },
      { name: "/five", description: "命令五" },
      { name: "/six", description: "命令六" },
      { name: "/seven", description: "命令七" },
      { name: "/eight", description: "命令八" },
    ])
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
  const setup = await createTestRenderer({ width: 60, height: 18, screenMode: "split-footer", footerHeight: 12 })
  try {
    const editor = createChatEditor(setup.renderer, { onSubmit: () => {}, onAbort: () => {}, onQuit: () => {} }, [
      { name: "/one", description: "命令一" },
      { name: "/two", description: "命令二" },
      { name: "/three", description: "命令三" },
      { name: "/four", description: "命令四" },
      { name: "/five", description: "命令五" },
      { name: "/six", description: "命令六" },
      { name: "/seven", description: "命令七" },
      { name: "/eight", description: "命令八" },
    ])
    // 可见候选窗口 = 容器高度（footer 12 - 固定 5 - 输入 1 = 6 行）。
    editor.input.setText("/")
    await Bun.sleep(1)
    for (let index = 0; index < 4; index += 1) emitKey(setup.renderer, "\x1b[B")
    await setup.renderOnce()
    const centered = setup.captureCharFrame()
    expect(centered).toContain("▶ /five")
    expect(centered).toContain("/two")
    expect(centered).toContain("/seven")
    expect(centered).not.toContain("/one")
    expect(centered).not.toContain("/eight")

    for (let index = 0; index < 3; index += 1) emitKey(setup.renderer, "\x1b[B")
    await setup.renderOnce()
    const atEnd = setup.captureCharFrame()
    expect(atEnd).toContain("▶ /eight")
    expect(atEnd).toContain("/three")
    expect(atEnd).not.toContain("/two")
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("矮终端优先保留状态和错误行并隐藏快捷键提示", async () => {
  const setup = await createTestRenderer({ width: 60, height: 9, screenMode: "split-footer", footerHeight: 8 })
  try {
    const editor = createChatEditor(
      setup.renderer,
      { onSubmit: () => {}, onAbort: () => {}, onQuit: () => {} },
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
    expect(frame).toContain("错误状态必须可见")
    // 矮终端不足以容纳固定 5 + 输入 1 + 输出区 3，优先隐藏快捷键提示行。
    expect(frame).not.toContain("快捷键状态必须可见")
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

test("命令补全弹出与收起不改变 footer 高度", async () => {
  const setup = await createTestRenderer({ width: 60, height: 16, screenMode: "split-footer", footerHeight: 12 })
  try {
    const editor = createChatEditor(
      setup.renderer,
      { onSubmit: () => {}, onAbort: () => {}, onQuit: () => {} },
      commands,
    )
    const before = setup.renderer.footerHeight
    editor.input.setText("/")
    await Bun.sleep(1)
    expect(setup.renderer.footerHeight).toBe(before)
    editor.input.setText("普通文本")
    await Bun.sleep(1)
    expect(setup.renderer.footerHeight).toBe(before)
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("命令补全替换输出区时与输出区等高，footer 底部无空白", async () => {
  const setup = await createTestRenderer({ width: 60, height: 16, screenMode: "split-footer", footerHeight: 12 })
  try {
    const editor = createChatEditor(
      setup.renderer,
      { onSubmit: () => {}, onAbort: () => {}, onQuit: () => {} },
      commands,
    )
    // 输出区高度 = footer 12 - 固定 5 - 输入 1 = 6。
    editor.input.setText("/")
    await Bun.sleep(1)
    await setup.renderOnce()
    expect(setup.renderer.footerHeight).toBe(12)
    const commandList = setup.renderer.root.getRenderable("editor-command-list")
    expect(commandList?.height).toBe(6)
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n").filter((line) => line.length > 0)
    expect(lines).toHaveLength(12)
    // 底部固定行（信息行）仍可见，底部无因高度不一致产生的空白。
    expect(lines.at(-3) ?? "").toContain("模型")
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})
