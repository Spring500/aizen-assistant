import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { createTestRenderer } from "@opentui/core/testing"
import { createOutputPanel, type OutputData } from "../../packages/tui-kit/output-panel.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

function data(overrides: Partial<OutputData> = {}): OutputData {
  return { streamingText: "", streamingThinking: "", tools: [], ...overrides }
}

async function setupPanel(height = 12) {
  const setup = await createTestRenderer({
    width: 80,
    height: 20,
    screenMode: "split-footer",
    footerHeight: height,
  })
  const panel = createOutputPanel(setup.renderer)
  setup.renderer.root.add(panel.root)
  return { ...setup, panel }
}

test("输出区显示流式文本", async () => {
  const setup = await setupPanel()
  try {
    setup.panel.setHeight(6)
    setup.panel.update(data({ streamingText: "partial answer" }))
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("[助手流式]")
    expect(frame).toContain("partial answer")
  } finally {
    setup.renderer.destroy()
  }
})

test("有工具时每工具一行并挤压流式输出空间", async () => {
  const setup = await setupPanel()
  try {
    setup.panel.setHeight(6)
    setup.panel.update(
      data({
        streamingText: "stream content",
        tools: [
          {
            id: "c1",
            name: "bash",
            intent: "运行测试",
            outputPreview: "compiling...",
            isFinished: false,
            isError: false,
          },
        ],
      }),
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("[bash] 运行测试 | 运行中：compiling...")
    expect(frame).toContain("stream content")
  } finally {
    setup.renderer.destroy()
  }
})

test("工具行超过输出区上限时截断并提示剩余数量", async () => {
  const setup = await setupPanel()
  try {
    setup.panel.setHeight(6)
    const tools: OutputData["tools"] = Array.from({ length: 5 }, (_, index) => ({
      id: `c${index}`,
      name: "bash",
      isFinished: false,
      isError: false,
    }))
    setup.panel.update(data({ tools, streamingText: "有流式内容" }))
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    // 有流式内容时为其保留保底行：6 行中流式保底 3，工具最多 3 行（显示 2 个 + 剩余提示）。
    expect(frame).toContain("… 还有 3 个工具")
  } finally {
    setup.renderer.destroy()
  }
})

test("无工具也无流式内容时输出区为空", async () => {
  const setup = await setupPanel()
  try {
    setup.panel.setHeight(6)
    setup.panel.update(data())
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("运行中")
    expect(frame).not.toContain("流式")
  } finally {
    setup.renderer.destroy()
  }
})

test("工具完成后显示完成状态，失败显示失败状态", async () => {
  const setup = await setupPanel()
  try {
    setup.panel.setHeight(6)
    setup.panel.update(
      data({
        tools: [
          {
            id: "c1",
            name: "bash",
            intent: "运行测试",
            outputPreview: "all passed",
            isFinished: true,
            isError: false,
          },
          {
            id: "c2",
            name: "read",
            intent: "读取文件",
            outputPreview: "not found",
            isFinished: true,
            isError: true,
          },
        ],
      }),
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("[bash] 运行测试 | 完成：all passed")
    expect(frame).toContain("[read] 读取文件 | 失败：not found")
  } finally {
    setup.renderer.destroy()
  }
})

test("无内容时输出区高度收缩到最小，footer 底部留白", async () => {
  const setup = await setupPanel()
  try {
    setup.panel.setHeight(6)
    setup.panel.update(data())
    await setup.renderOnce()
    // OpenTUI 布局强制 Box 高度至少为 1：空内容时收缩到最小 1 行。
    expect(setup.panel.root.height).toBe(1)
    // 有流式内容时用满分配高度。
    setup.panel.update(data({ streamingText: "hello" }))
    await setup.renderOnce()
    expect(setup.panel.root.height).toBe(6)
  } finally {
    setup.renderer.destroy()
  }
})

test("仅工具无流式内容时输出区高度按内容收缩", async () => {
  const setup = await setupPanel()
  try {
    setup.panel.setHeight(6)
    setup.panel.update(data({ tools: [{ id: "c1", name: "bash", isFinished: true, isError: false }] }))
    await setup.renderOnce()
    // 只有 1 个工具行，高度收缩为 1。
    expect(setup.panel.root.height).toBe(1)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("[bash]")
  } finally {
    setup.renderer.destroy()
  }
})
