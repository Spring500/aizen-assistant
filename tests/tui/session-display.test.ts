import { expect } from "bun:test"
import { sessionDisplay } from "../../apps/tui/session-display.ts"
import type { SessionSummary } from "../../packages/core/session-store.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const base: SessionSummary = {
  sessionId: "session-1",
  name: "需求讨论",
  cwd: "E:\\project",
  createdAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:00:00.000Z",
  preview: "检查锁",
  issues: [],
  capabilities: { canOpen: true, canForceOpen: false },
}

test("当前会话显示当前标识和独立颜色", async () => {
  const item = sessionDisplay({ ...base, lockState: "current" }, "session-1")
  expect(item.segments.map((segment) => segment.text).join("")).toContain("[当前]")
  expect(item.segments.some((segment) => segment.color === systemColors.accent)).toBe(true)
  expect(item.disabled).toBeUndefined()
})

test("其他实例占用会话显示使用中标识、特殊颜色并禁用", async () => {
  const item = sessionDisplay(
    {
      ...base,
      lockState: "occupied",
      issues: [{ code: "session.in_use", label: "使用中", message: "会话正在使用" }],
      capabilities: { canOpen: false, canForceOpen: false },
    },
    "other",
  )
  expect(item.segments.map((segment) => segment.text).join("")).toContain("[使用中]")
  expect(item.segments.some((segment) => segment.color === systemColors.warning)).toBe(true)
  expect(item.disabled).toBe(true)
  expect(item.disabledReason).toBe("会话正在使用")
})

const issueCases = [
  {
    code: "session.incompatible_record",
    label: "不兼容",
    capabilities: { canOpen: true, canForceOpen: true },
    disabled: false,
  },
  {
    code: "session.invalid_json",
    label: "内容损坏",
    capabilities: { canOpen: false, canForceOpen: false },
    disabled: true,
  },
  {
    code: "session.incomplete_tail",
    label: "未完整写入",
    capabilities: { canOpen: true, canForceOpen: false },
    disabled: false,
  },
  {
    code: "session.read_failed",
    label: "读取失败",
    capabilities: { canOpen: false, canForceOpen: false },
    disabled: true,
  },
] as const

for (const issueCase of issueCases) {
  test(`问题条目显示 ${issueCase.label} 标识并遵循对应操作能力`, async () => {
    const item = sessionDisplay({
      ...base,
      issues: [{ code: issueCase.code, label: issueCase.label, message: `${issueCase.label}详情` }],
      capabilities: issueCase.capabilities,
    })
    expect(item.segments.map((segment) => segment.text).join("")).toContain(`[${issueCase.label}]`)
    expect((item.details ?? []).map((detail) => detail.text).join("")).toContain(`${issueCase.label}详情`)
    expect(item.disabled === true).toBe(issueCase.disabled)
  })
}

test("含不兼容记录的会话可直接打开并保留风险标记", () => {
  const item = sessionDisplay(
    {
      ...base,
      issues: [{ code: "session.incompatible_record", label: "不兼容", message: "存在不兼容记录" }],
      capabilities: { canOpen: true, canForceOpen: true },
    },
    "other",
  )
  expect(item.disabled).toBeUndefined()
  expect(item.segments.map((segment) => segment.text).join("")).toContain("[不兼容]")
})
