import { expect, test } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { OverlayManager } from "../../packages/tui-kit/overlay-manager.ts"
import { promptLine } from "../../packages/tui-kit/prompt.ts"
import { selectItem } from "../../packages/tui-kit/selector.ts"

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
    const child = promptLine(overlays, "child", "名称：")
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
    let child: Promise<string> | undefined
    const parent = overlays.open({
      id: "opener",
      title: "父层",
      contentHeight: 2,
      input: {
        keypress: (event) => {
          if (event.name === "return") child = promptLine(overlays, "new-child", "输入：")
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
