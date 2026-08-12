import { expect } from "bun:test"
import { sessionDisplay } from "../../apps/tui/session-display.ts"
import type { SessionSummary } from "../../packages/core/session-store.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const base: SessionSummary = {
  entryId: "session-1.jsonl",
  sessionId: "session-1",
  name: "需求讨论",
  cwd: "E:\\project",
  createdAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:00:00.000Z",
  preview: "检查锁",
  state: "healthy",
  issues: [],
  capabilities: { canOpen: true, canWrite: true, canForceOpen: false, canRecover: false },
}

test("当前会话显示当前标识和独立颜色", async () => {
  const item = sessionDisplay({ ...base, lockState: "current" }, "session-1")
  expect(item.segments.map((segment) => segment.text).join("")).toContain("[当前]")
  expect(item.segments.some((segment) => segment.color === "#38bdf8")).toBe(true)
  expect(item.disabled).toBeUndefined()
})

test("其他实例占用会话显示使用中标识、特殊颜色并禁用", async () => {
  const item = sessionDisplay(
    {
      ...base,
      lockState: "occupied",
      state: "unavailable",
      issues: [{ code: "session.in_use", category: "availability", label: "使用中", message: "会话正在使用" }],
      capabilities: { canOpen: false, canWrite: false, canForceOpen: false, canRecover: false },
    },
    "other",
  )
  expect(item.segments.map((segment) => segment.text).join("")).toContain("[使用中]")
  expect(item.segments.some((segment) => segment.color === "#f97316")).toBe(true)
  expect(item.disabled).toBe(true)
  expect(item.disabledReason).toBe("会话正在使用")
})

for (const [label, category] of [
  ["不兼容", "integrity"],
  ["内容损坏", "syntax"],
  ["未完整写入", "incomplete"],
  ["ID 冲突", "conflict"],
  ["读取失败", "io"],
] as const) {
  test(`问题条目显示 ${label} 标识`, async () => {
    const item = sessionDisplay({
      ...base,
      state: "unavailable",
      issues: [{ code: `test.${label}`, category, label, message: `${label}详情` }],
      capabilities: { canOpen: false, canWrite: false, canForceOpen: true, canRecover: true },
    })
    expect(item.segments.map((segment) => segment.text).join("")).toContain(`[${label}]`)
    expect((item.details ?? []).map((detail) => detail.text).join("")).toContain(`${label}详情`)
  })
}
