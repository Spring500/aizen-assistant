import { expect, test } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createChatView } from "../../packages/tui-kit/chat-view.ts"
import { createChatEditor } from "../../packages/tui-kit/editor.ts"
import { selectItem } from "../../packages/tui-kit/selector.ts"

test("选择器可用 Esc 取消并清理界面", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  try {
    const pending = selectItem(setup.renderer, "selector", [{ name: "第一项", description: "说明", value: "first" }], {
      title: "选择项目",
    })
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
    const pending = selectItem(
      setup.renderer,
      "provider-selector",
      [{ name: "Anthropic", description: "需要 API 密钥", value: "anthropic" }],
      { title: "选择服务商" },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Anthropic")
    expect(frame).toContain("需要 API 密钥")
    expect(frame).toContain("选择服务商")

    const parsed = parseKeypress("\x1b")
    if (!parsed) throw new Error("无法解析 Esc")
    setup.renderer.keyInput.emit("keypress", new KeyEvent(parsed))
    await pending
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("认证方式选择器显示候选项", async () => {
  const setup = await createTestRenderer({ width: 80, height: 20 })
  try {
    const pending = selectItem(
      setup.renderer,
      "auth-selector",
      [
        { name: "Bearer token", description: "", value: "bearer-token" },
        { name: "AWS profile", description: "", value: "aws-profile" },
      ],
      { title: "选择 Amazon Bedrock 认证方式" },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("选择 Amazon Bedrock 认证方式")
    expect(frame).toContain("Bearer token")
    expect(frame).toContain("AWS profile")

    const parsed = parseKeypress("\x1b")
    if (!parsed) throw new Error("无法解析 Esc")
    setup.renderer.keyInput.emit("keypress", new KeyEvent(parsed))
    await pending
  } finally {
    setup.renderer.destroy()
  }
})

test("退出信号会结束正在等待的选择", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const controller = new AbortController()
  try {
    const pending = selectItem(setup.renderer, "selector", [{ name: "第一项", description: "说明", value: "first" }], {
      title: "选择项目",
      signal: controller.signal,
    })
    controller.abort()
    expect(await pending).toBeUndefined()
  } finally {
    setup.renderer.destroy()
  }
})

test("split-footer 中选择器临时扩大显示区域并在退出后恢复", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 20,
    screenMode: "split-footer",
    footerHeight: 8,
  })
  try {
    const pending = selectItem(
      setup.renderer,
      "large-selector",
      Array.from({ length: 6 }, (_, index) => ({
        name: `会话 ${index + 1}`,
        description: `第 ${index + 1} 条会话`,
        value: index,
      })),
      { title: "选择会话" },
    )
    expect(setup.renderer.footerHeight).toBe(18)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("会话 1")
    expect(frame).toContain("会话 4")

    const parsed = parseKeypress("\x1b")
    if (!parsed) throw new Error("无法解析 Esc")
    setup.renderer.keyInput.emit("keypress", new KeyEvent(parsed))
    expect(await pending).toBeUndefined()
    expect(setup.renderer.footerHeight).toBe(8)
  } finally {
    setup.renderer.destroy()
  }
})
