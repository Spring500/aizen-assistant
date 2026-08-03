import { afterEach, expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createScrollableTextView } from "../../packages/tui-kit/scrollable-text-view.ts"

const renderers: Array<Awaited<ReturnType<typeof createTestRenderer>>> = []
afterEach(() => {
  for (const setup of renderers.splice(0)) setup.renderer.destroy()
})

async function setupView(width = 30, height = 8) {
  const setup = await createTestRenderer({ width, height })
  renderers.push(setup)
  const parent = new BoxRenderable(setup.renderer, {
    id: `scroll-parent-${renderers.length}`,
    width: "100%",
    height: "100%",
    overflow: "hidden",
  })
  setup.renderer.root.add(parent)
  return { setup, parent }
}

test("自动换行后按实际视觉行滚动并识别末尾", async () => {
  const { setup, parent } = await setupView()
  let viewed = 0
  const view = createScrollableTextView(setup.renderer, {
    id: "scrollable-text-lines",
    parent,
    content: "0123456789 ".repeat(30),
    onViewedToEnd: () => viewed++,
  })
  await setup.renderOnce()
  const initial = view.refresh()
  expect(initial.totalLines).toBeGreaterThan(initial.viewportLines)
  expect(initial.atEnd).toBe(false)
  expect(viewed).toBe(0)
  view.scrollBy(10_000)
  const bottom = view.refresh()
  expect(bottom.atEnd).toBe(true)
  expect(viewed).toBe(1)
  view.dispose()
})

test("resize 后使用 OpenTUI 新排版结果校正滚动状态", async () => {
  const { setup, parent } = await setupView(30, 8)
  const view = createScrollableTextView(setup.renderer, {
    id: "scrollable-text-resize",
    parent,
    content: "ABCDEFGHIJ ".repeat(25),
  })
  await setup.renderOnce()
  const narrow = view.refresh()
  expect(narrow.totalLines).toBeGreaterThan(1)
  setup.resize(80, 8)
  await setup.renderOnce()
  await Bun.sleep(1)
  const wide = view.refresh()
  expect(wide.totalLines).toBeLessThan(narrow.totalLines)
  expect(view.renderable.scrollY).toBeLessThanOrEqual(view.renderable.maxScrollY)
  view.dispose()
})

test("dispose 后不再响应 resize", async () => {
  const { setup, parent } = await setupView()
  let updates = 0
  const view = createScrollableTextView(setup.renderer, {
    id: "scrollable-text-dispose",
    parent,
    content: "dispose ".repeat(40),
    onStateChange: () => updates++,
  })
  await setup.renderOnce()
  view.refresh()
  view.dispose()
  const before = updates
  setup.resize(40, 8)
  await setup.renderOnce()
  await Bun.sleep(1)
  expect(updates).toBe(before)
})
