import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { contextReportText } from "../../packages/tui-kit/context-report-view.ts"
import type { ContextReport } from "../../packages/core/types.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

test("报告分章节展示系统提示词、注入上下文与激活工具 Schema", () => {
  const report: ContextReport = {
    systemPrompt: "完整系统提示词",
    activeToolNames: ["read"],
    tools: [
      { name: "read", description: "读取文件", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { name: "write", description: "写入文件", parameters: { type: "object", properties: {} } },
    ],
    injectedItems: [{ source: "clock", role: "developer", useLater: false, parts: [{ kind: "text", text: "临时上下文" }] }],
  }
  const text = contextReportText(report)
  expect(text).toContain("【系统提示词】")
  expect(text).toContain("完整系统提示词")
  expect(text).toContain("【下一条消息注入的上下文】")
  expect(text).toContain("[clock] 临时上下文")
  expect(text).toContain("【工具 Schema（当前激活 1 个）】")
  expect(text).toContain("## read")
  expect(text).toContain('"type": "string"')
  // 未激活工具只列出名称，不展示 Schema
  expect(text).toContain("未激活工具：write")
  expect(text).not.toContain("## write")
})

test("无注入上下文时显示占位说明", () => {
  const report: ContextReport = {
    systemPrompt: "",
    activeToolNames: [],
    tools: [],
    injectedItems: [],
  }
  const text = contextReportText(report)
  expect(text).toContain("【系统提示词】")
  expect(text).toContain("（无）")
  expect(text).toContain("【下一条消息注入的上下文】\n（无）")
})
