import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { KeyEvent, parseKeypress, rgbToHex } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createChatEditor } from "../../packages/tui-kit/editor.ts"
import { shortcutText } from "../../packages/tui-kit/status-bar.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

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

test("忙碌状态输入区保持可见且文字变暗淡，仍可输入但不可发送", async () => {
  const setup = await createTestRenderer({
    width: 60,
    height: 8,
    screenMode: "split-footer",
    footerHeight: 8,
  })
  const submitted: string[] = []
  try {
    const editor = createChatEditor(setup.renderer, {
      onSubmit: (value) => submitted.push(value),
      onAbort: () => {},
      onQuit: () => {},
    })
    // 输入区处于可见状态时置为忙碌：输入区不消失、可继续输入，但回车不发送，文字变暗淡。
    editor.setInputVisible(true)
    editor.setBusy(true)
    expect(editor.input.visible).toBe(true)
    expect(rgbToHex(editor.input.textColor as never)).toBe(systemColors.dim)
    editor.input.setText("运行中打字")
    editor.input.submit()
    expect(submitted).toEqual([])
    expect(editor.input.plainText).toBe("运行中打字")
    // 恢复空闲：颜色还原为默认亮色，提交恢复。
    editor.setBusy(false)
    expect(rgbToHex(editor.input.textColor as never)).toBe(systemColors.text)
    editor.input.submit()
    expect(submitted).toEqual(["运行中打字"])
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("编辑器可只隐藏输入框并保持底部状态栏可见", async () => {
  const setup = await createTestRenderer({
    width: 120,
    height: 12,
    screenMode: "split-footer",
    footerHeight: 12,
  })
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
    footerHeight: 12,
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
    // 输入区按内容行数取（上限 = footer 总高 - 固定 5 - 输出区保底 3）。
    expect(editor.input.height).toBe(3)
    expect(setup.renderer.footerHeight).toBe(12)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("修复登录重试  otter-builds-bridge──")
    expect(frame).toContain("第一行")
    expect(frame).toContain("第三行")

    editor.input.setText(Array.from({ length: 12 }, (_, index) => `第 ${index} 行`).join("\n"))
    for (let attempt = 0; attempt < 20 && editor.input.height !== 4; attempt += 1) await Bun.sleep(5)
    // 内容行数超过上限时输入区封顶，footer 总高度不变。
    expect(editor.input.height).toBe(4)
    expect(setup.renderer.footerHeight).toBe(12)
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("可以回填编辑器文本", async () => {
  const setup = await createTestRenderer({ width: 60, height: 15 })
  const editor = createChatEditor(setup.renderer, { onSubmit() {}, onAbort() {}, onQuit() {} })
  try {
    editor.setInputText("重新编辑的问题")
    expect(editor.input.plainText).toBe("重新编辑的问题")
    expect(editor.input.cursorOffset).toBe(editor.input.plainText.length)
  } finally {
    editor.destroy()
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
  expect(shortcutText({ status: "idle", hasSession: true })).not.toContain("/model")
  expect(shortcutText({ status: "idle", hasSession: false })).toContain("↑/↓ 选择")
})

test("两条分割线内容右端对齐到同一列，耗时追加在状态后", async () => {
  const setup = await createTestRenderer({ width: 60, height: 16, screenMode: "split-footer", footerHeight: 12 })
  try {
    const editor = createChatEditor(setup.renderer, { onSubmit: () => {}, onAbort: () => {}, onQuit: () => {} })
    editor.setSessionTitle({ name: "修复登录重试", sessionId: "otter-builds-bridge" })
    editor.setSessionStatus({
      text: "处理中",
      tone: "running",
      metrics: { startedAt: Date.now(), elapsedSeconds: 7, outputTokens: 42 },
    })
    await setup.renderOnce()
    const lines = setup.captureCharFrame().split("\n")
    const titleLine = lines.find((value) => value.includes("otter-builds-bridge"))
    const statusLine = lines.find((value) => value.includes("处理中 · 耗时 7s · 生成 42 tokens"))
    if (!titleLine || !statusLine) throw new Error("两条分割线应分别包含标题与会话状态+耗时")
    const titleRight = titleLine.indexOf("otter-builds-bridge") + "otter-builds-bridge".length
    const statusRight =
      statusLine.indexOf("处理中 · 耗时 7s · 生成 42 tokens") + "处理中 · 耗时 7s · 生成 42 tokens".length
    // 两条分割线内容右端后都紧跟 2 列尾部横线（各自距行尾 2 列，即视觉对齐）。
    expect(titleLine.slice(titleRight)).toBe("──")
    expect(statusLine.slice(statusRight)).toBe("──")
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("窄终端下第二条分割线优先保留状态、从右截断耗时", async () => {
  const setup = await createTestRenderer({ width: 20, height: 16, screenMode: "split-footer", footerHeight: 12 })
  try {
    const editor = createChatEditor(setup.renderer, { onSubmit: () => {}, onAbort: () => {}, onQuit: () => {} })
    editor.setSessionStatus({
      text: "正在压缩上下文",
      tone: "running",
      metrics: { startedAt: Date.now(), elapsedSeconds: 123, outputTokens: 9999 },
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("正在压缩上下文")
    // 右侧信息区放不下完整耗时文本（20 列），但状态文本完整保留，且不出现换行/溢出。
    const lines = frame.split("\n")
    const statusLine = lines.find((value) => value.includes("正在压缩上下文"))
    if (!statusLine) throw new Error("应能找到状态行")
    expect(statusLine.trimEnd().length).toBeLessThanOrEqual(20)
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})
