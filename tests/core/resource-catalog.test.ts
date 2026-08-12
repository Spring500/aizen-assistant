import { expect } from "bun:test"
import { sessionIssues } from "../../packages/core/session-issues.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

test("Issue 定义表同时提供创建与运行时 code 校验", () => {
  expect(sessionIssues.has("session.invalid_json")).toBe(true)
  expect(sessionIssues.has("session.not_registered")).toBe(false)
  expect(sessionIssues.create("session.invalid_json", "内容无法解析")).toEqual({
    code: "session.invalid_json",
    category: "syntax",
    label: "内容损坏",
    message: "内容无法解析",
  })
})
