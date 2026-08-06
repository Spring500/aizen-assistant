import { expect } from "bun:test"
import { sessionDisplay } from "../../apps/tui/session-display.ts"
import type { SessionSummary } from "../../packages/core/session-store.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const base: SessionSummary = {
  sessionId: "session-1",
  name: "需求讨论",
  cwd: "E:\\project",
  createdAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:00:00.000Z",
  preview: "检查锁",
}

test("当前会话显示当前标识和独立颜色", async () => {
  const item = sessionDisplay({ ...base, lockState: "current" }, "session-1")
  expect(item.segments.map((segment) => segment.text).join("")).toContain("[当前]")
  expect(item.segments.some((segment) => segment.color === "#38bdf8")).toBe(true)
  expect(item.disabled).toBeUndefined()
})

test("其他实例占用会话显示已打开标识、特殊颜色并禁用", async () => {
  const item = sessionDisplay({ ...base, lockState: "occupied" }, "other")
  expect(item.segments.map((segment) => segment.text).join("")).toContain("[已打开]")
  expect(item.segments.some((segment) => segment.color === "#f97316")).toBe(true)
  expect(item.disabled).toBe(true)
  expect(item.disabledReason).toBe("会话正在被其他 Agent 使用")
})
