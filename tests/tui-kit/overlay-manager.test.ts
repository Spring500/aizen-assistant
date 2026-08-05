import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { promptAuthInput } from "../../packages/tui-kit/auth-input.ts"
import { OverlayManager } from "../../packages/tui-kit/overlay-manager.ts"
import { selectItem } from "../../packages/tui-kit/selector.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

function key(sequence: string): KeyEvent {
  const parsed = parseKeypress(sequence)
  if (!parsed) throw new Error("无法解析按键")
  return new KeyEvent(parsed)
}

test("嵌套层只接收栈顶输入并逐层恢复", async () => {
  const setup = await createTestRenderer({
    width: 60,
    height: 20,
    screenMode: "split-footer",
    footerHeight: 8,
  })
  const overlays = new OverlayManager(setup.renderer)
  try {
    const parent = selectItem(
      overlays,
      "parent",
      [
        { name: "第一项", description: "", value: "first" },
        { name: "第二项", description: "", value: "second" },
      ],
      { title: "父层" },
    )
    const child = promptAuthInput(overlays, "child", "子层", "名称：")
    expect(overlays.depth).toBe(2)

    setup.renderer.keyInput.emit("keypress", key("x"))
    setup.renderer.keyInput.emit("keypress", key("\r"))
    expect(await child).toBe("x")
    expect(overlays.depth).toBe(1)

    setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
    setup.renderer.keyInput.emit("keypress", key("\r"))
    expect(await parent).toBe("second")
    expect(overlays.depth).toBe(0)
    expect(setup.renderer.footerHeight).toBe(8)
  } finally {
    overlays.dispose()
    setup.renderer.destroy()
  }
})

test("同一次 Enter 不会穿透到新打开的子层", async () => {
  const setup = await createTestRenderer({ width: 50, height: 15 })
  const overlays = new OverlayManager(setup.renderer)
  try {
    let child: Promise<string | undefined> | undefined
    const parent = overlays.open({
      id: "opener",
      title: "父层",
      contentHeight: 2,
      input: {
        keypress: (event) => {
          if (event.name === "return") child = promptAuthInput(overlays, "new-child", "子层", "输入：")
        },
      },
    })
    setup.renderer.keyInput.emit("keypress", key("\r"))
    expect(overlays.depth).toBe(2)
    expect(child).toBeDefined()

    setup.renderer.keyInput.emit("keypress", key("a"))
    setup.renderer.keyInput.emit("keypress", key("\r"))
    expect(await child).toBe("a")
    parent.close()
  } finally {
    overlays.dispose()
    setup.renderer.destroy()
  }
})

test("统一信息区支持动态说明、快捷键、错误和灰显反馈", async () => {
  const setup = await createTestRenderer({
    width: 28,
    height: 18,
    screenMode: "split-footer",
    footerHeight: 8,
  })
  const overlays = new OverlayManager(setup.renderer)
  let executed = 0
  try {
    const handle = overlays.open({
      id: "information-regions",
      title: "统一信息区",
      description: "这是一段包含中文和 emoji 😀 的很长说明，用于验证最多三行的动态布局能力。",
      contentHeight: 2,
      actions: [
        { id: "save", key: { name: "return" }, label: "Enter 保存", run: () => executed++ },
        {
          id: "delete",
          key: { name: "x", ctrl: true },
          label: "Ctrl+X 删除",
          enabled: false,
          disabledReason: "至少保留一个项目",
          run: () => executed++,
        },
        { id: "hidden", key: { name: "h" }, label: "H 隐藏", applicable: false, run: () => executed++ },
      ],
    })
    handle.setError("名称不能为空")
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Enter 保存")
    expect(frame).toContain("Ctrl+X 删除")
    expect(frame).not.toContain("H 隐藏")
    expect(frame).toContain("名称不能为空")
    expect(setup.renderer.footerHeight).toBeGreaterThanOrEqual(7)

    setup.renderer.keyInput.emit("keypress", key("\x18"))
    await setup.renderOnce()
    expect(executed).toBe(0)
    expect(setup.captureCharFrame()).toContain("至少保留一个项目")

    setup.renderer.keyInput.emit("keypress", key("\r"))
    expect(executed).toBe(1)
    handle.clearError()
    handle.close()
  } finally {
    overlays.dispose()
    setup.renderer.destroy()
  }
})

test("子层关闭后恢复父层的三类信息", async () => {
  const setup = await createTestRenderer({ width: 50, height: 16 })
  const overlays = new OverlayManager(setup.renderer)
  try {
    const parent = overlays.open({ id: "info-parent", title: "父层", description: "父层说明", contentHeight: 2 })
    parent.setError("父层错误")
    const child = overlays.open({ id: "info-child", title: "子层", description: "子层说明", contentHeight: 2 })
    child.setError("子层错误")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("子层错误")
    child.close()
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("父层说明")
    expect(frame).toContain("父层错误")
    parent.close()
  } finally {
    overlays.dispose()
    setup.renderer.destroy()
  }
})

test("resize 会重算统一容器且关闭后不残留", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 9,
  })
  const overlays = new OverlayManager(setup.renderer)
  try {
    const pending = selectItem(
      overlays,
      "resize-selector",
      Array.from({ length: 20 }, (_, index) => ({
        name: `中文项目 ${index}`,
        description: "😀 全角说明",
        value: index,
      })),
      { title: "宽字符与 resize" },
    )
    setup.renderer.resize(32, 8)
    await Bun.sleep(20)
    await setup.renderOnce()
    expect(setup.renderer.footerHeight).toBeLessThanOrEqual(8)
    expect(setup.captureCharFrame()).toContain("宽字符与 resize")

    setup.renderer.keyInput.emit("keypress", key("\x1b"))
    expect(await pending).toBeUndefined()
    expect(setup.renderer.root.getRenderable("resize-selector-overlay")).toBeUndefined()
    expect(setup.renderer.footerHeight).toBe(9)
  } finally {
    overlays.dispose()
    setup.renderer.destroy()
  }
})
