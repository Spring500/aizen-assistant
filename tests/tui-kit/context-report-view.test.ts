import { afterEach, expect } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { showContextReport, toolLines } from "../../packages/tui-kit/context-report-view.ts"
import { OverlayManager } from "../../packages/tui-kit/overlay-manager.ts"
import type { RuntimeToolInfo } from "../../packages/core/pi-port.ts"
import type { ContextReport } from "../../packages/core/types.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const renderers: Array<Awaited<ReturnType<typeof createTestRenderer>>> = []
afterEach(() => {
  for (const setup of renderers.splice(0)) setup.renderer.destroy()
})

function key(value: string): KeyEvent {
  const parsed = parseKeypress(value)
  if (!parsed) throw new Error("按键无效")
  return new KeyEvent(parsed)
}

test("工具参数按名称、类型、描述着色分片，必填参数标注星号", () => {
  const tool: RuntimeToolInfo = {
    name: "read",
    description: "读取文件内容",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        offset: { type: "number", description: "起始行" },
      },
      required: ["path"],
    },
  }
  const lines = toolLines(tool)
  expect(lines.map((line) => line.spans.map((span) => span.text).join(""))).toEqual([
    "[read]  读取文件内容",
    "- path* | string  文件路径",
    "- offset | number  起始行",
  ])
  expect(lines[0]?.spans[0]).toEqual({ text: "[read]", style: "name" })
  expect(lines[0]?.spans[1]).toEqual({ text: "  读取文件内容", style: "description" })
  expect(lines[1]?.spans).toContainEqual({ text: "path", style: "paramName" })
  expect(lines[1]?.spans).toContainEqual({ text: "*", style: "required" })
  expect(lines[1]?.spans).toContainEqual({ text: "string", style: "typeString" })
  expect(lines[2]?.spans).toContainEqual({ text: "number", style: "typeNumber" })
})

test("嵌套 object 与 array<object> 递归加深缩进并保留必填标注", () => {
  const tool: RuntimeToolInfo = {
    name: "edit",
    description: "",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          description: "编辑列表",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "原文" },
            },
            required: ["oldText"],
          },
        },
      },
      required: ["edits"],
    },
  }
  const lines = toolLines(tool)
  expect(lines.map((line) => `${line.indent}:${line.spans.map((span) => span.text).join("")}`)).toEqual([
    "0:[edit]",
    "1:- path | string",
    "1:- edits* | array<object>  编辑列表",
    "2:- oldText* | string  原文",
  ])
})

test("枚举与布尔类型使用可读标签，空描述不产生空片段", () => {
  const tool: RuntimeToolInfo = {
    name: "write",
    description: "",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["append", "overwrite"] },
        atomic: { type: "boolean" },
      },
      required: [],
    },
  }
  const lines = toolLines(tool)
  expect(lines.map((line) => line.spans.map((span) => span.text).join(""))).toEqual([
    "[write]",
    '- mode | enum["append","overwrite"]',
    "- atomic | boolean",
  ])
  expect(lines[2]?.spans).toContainEqual({ text: "boolean", style: "typeBoolean" })
})

test("运行时上下文浮窗分章节渲染系统提示词、注入上下文与工具并可 Esc 关闭", async () => {
  const setup = await createTestRenderer({ width: 80, height: 30 })
  renderers.push(setup)
  const overlays = new OverlayManager(setup.renderer)
  const report: ContextReport = {
    systemPrompt: "# 标题\n这是系统提示词",
    activeToolNames: ["read"],
    tools: [
      {
        name: "read",
        description: "读取文件",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "路径" } },
          required: ["path"],
        },
      },
    ],
    injectedItems: [
      { source: "clock", role: "developer", useLater: false, parts: [{ kind: "text", text: "临时上下文" }] },
    ],
  }
  let closed = false
  const showing = showContextReport(overlays, report).then(() => {
    closed = true
  })
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("运行时上下文")
  expect(frame).toContain("系统提示词")
  expect(frame).toContain("标题")
  expect(frame).toContain("下一条消息注入的上下文")
  expect(frame).toContain("工具 Schema")
  expect(frame).toContain("[read]")
  expect(frame).toContain("path")
  // 异步树解析完成后隐藏标题标记，与聊天转录的最终样式一致。
  await Bun.sleep(200)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).not.toContain("# 标题")
  setup.renderer.keyInput.emit("keypress", key("\x1b"))
  await showing
  expect(closed).toBe(true)
})
