import { expect, test } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { selectEditableItem } from "../../packages/tui-kit/editable-selector.ts"

function key(sequence: string): KeyEvent {
  const parsed = parseKeypress(sequence)
  if (!parsed) throw new Error("无法解析按键")
  return new KeyEvent(parsed)
}

test("可编辑菜单在当前选项内编辑并保留页面", async () => {
  const setup = await createTestRenderer({ width: 60, height: 16 })
  let name = "ac"
  try {
    const pending = selectEditableItem(
      setup.renderer,
      "editable-menu",
      () => [
        {
          name: `名称  ${name}`,
          description: "原地编辑名称",
          value: "name" as const,
          edit: {
            label: "名称  ",
            value: name,
            save: (value: string) => {
              name = value
            },
          },
        },
        { name: "保存", description: "返回表单", value: "save" as const },
      ],
      { title: "编辑表单" },
    )
    setup.renderer.keyInput.emit("keypress", key("\r"))
    await Bun.sleep(1)
    await setup.renderOnce()
    const editingFrame = setup.captureCharFrame()
    expect(editingFrame).toContain("名称  ac")
    expect(editingFrame).toContain("保存")
    expect(editingFrame).toContain("编辑表单")
    expect(setup.renderer.root.getRenderable("editable-menu-overlay")).toBeDefined()

    setup.renderer.keyInput.emit("keypress", key("\x1b[D"))
    setup.renderer.keyInput.emit("keypress", key("b"))
    setup.renderer.keyInput.emit("keypress", key("\r"))
    await Bun.sleep(1)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("名称  abc")
    setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
    setup.renderer.keyInput.emit("keypress", key("\r"))
    expect(await pending).toBe("save")
  } finally {
    setup.renderer.destroy()
  }
})

test("可编辑菜单把校验失败写入错误说明行", async () => {
  const setup = await createTestRenderer({ width: 50, height: 14 })
  try {
    const pending = selectEditableItem(
      setup.renderer,
      "validated-menu",
      () => [
        {
          name: "名称",
          description: "不能为空",
          value: "name",
          edit: {
            label: "名称  ",
            value: "",
            validate: (value: string) => (value.trim() ? undefined : "名称不能为空"),
          },
        },
      ],
      { title: "校验表单" },
    )
    setup.renderer.keyInput.emit("keypress", key("\r"))
    setup.renderer.keyInput.emit("keypress", key("\r"))
    await Bun.sleep(1)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("名称不能为空")
    setup.renderer.keyInput.emit("keypress", key("\x1b"))
    await Bun.sleep(1)
    setup.renderer.keyInput.emit("keypress", key("\x1b"))
    expect(await pending).toBeUndefined()
  } finally {
    setup.renderer.destroy()
  }
})
