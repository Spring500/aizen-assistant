import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { selectEditableItem } from "../../packages/tui-kit/editable-selector.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

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
    expect(editingFrame).toContain("▶ 名称  ac")
    expect(editingFrame).toContain("保存")
    expect(editingFrame).not.toContain("名称  acac")
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

test("可编辑菜单滚动后仍在选中行值区域编辑", async () => {
  const setup = await createTestRenderer({ width: 52, height: 12 })
  let value = "old"
  try {
    const pending = selectEditableItem(
      setup.renderer,
      "scroll-editable-menu",
      () =>
        Array.from({ length: 14 }, (_, index) => ({
          name: `字段 ${String(index).padStart(2, "0")}       ${index === 13 ? value : `值 ${index}`}`,
          description: `第 ${index + 1} 项`,
          value: index,
          ...(index === 13
            ? {
                edit: {
                  label: "字段 13       ",
                  value,
                  save: (next: string) => {
                    value = next
                  },
                },
              }
            : {}),
        })),
      { title: "滚动编辑" },
    )
    for (let index = 0; index < 13; index += 1) setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
    setup.renderer.keyInput.emit("keypress", key("\r"))
    await Bun.sleep(1)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("▶ 字段 13       old")
    expect(frame).not.toContain("oldold")
    setup.renderer.keyInput.emit("keypress", key("\x1b"))
    await Bun.sleep(1)
    setup.renderer.keyInput.emit("keypress", key("\x1b"))
    expect(await pending).toBeUndefined()
  } finally {
    setup.renderer.destroy()
  }
})

test("可编辑菜单 resize 后保持当前行缩进与输入对齐", async () => {
  const setup = await createTestRenderer({ width: 60, height: 14 })
  try {
    const pending = selectEditableItem(
      setup.renderer,
      "resize-editable-menu",
      () => [
        {
          name: "显示名称        测试名称",
          description: "调整终端宽度",
          value: "name",
          edit: { label: "显示名称        ", value: "测试名称" },
        },
        { name: "保存", description: "保持可见", value: "save" },
      ],
      { title: "resize 编辑" },
    )
    setup.renderer.keyInput.emit("keypress", key("\r"))
    setup.renderer.resize(34, 10)
    await Bun.sleep(20)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("▶ 显示名称        测试名称")
    expect(frame).toContain("保存")
    setup.renderer.keyInput.emit("keypress", key("\x1b"))
    await Bun.sleep(1)
    setup.renderer.keyInput.emit("keypress", key("\x1b"))
    expect(await pending).toBeUndefined()
  } finally {
    setup.renderer.destroy()
  }
})

test("可编辑菜单切换行后保留未保存草稿", async () => {
  const setup = await createTestRenderer({ width: 60, height: 14 })
  try {
    const pending = selectEditableItem(
      setup.renderer,
      "draft-menu",
      () => [
        {
          id: "name",
          name: "名称  old",
          description: "草稿字段",
          value: "name",
          edit: { label: "名称  ", value: "old" },
        },
        { name: "保存", description: "普通选项", value: "save" },
      ],
      { title: "草稿保留" },
    )
    setup.renderer.keyInput.emit("keypress", key("x"))
    setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
    setup.renderer.keyInput.emit("keypress", key("\x1b[A"))
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("▶ 名称  oldx")
    setup.renderer.keyInput.emit("keypress", key("\x1b"))
    expect(await pending).toBeUndefined()
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
