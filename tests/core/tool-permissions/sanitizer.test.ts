import { expect, test } from "bun:test"
import { sanitizePermissionAuditPayload } from "../../../packages/core/tool-permissions/sanitizer.ts"

test("权限记录隐藏完整详情、危险证据和第三方敏感字段", () => {
  const sanitized = sanitizePermissionAuditPayload(
    {
      request: { arguments: { releaseCode: "REAL-SECRET", path: "source.ts" } },
      decision: {
        assessment: {
          details: { patch: "完整 diff", edits: [{ oldText: "旧源码", newText: "新源码" }] },
          findings: [{ evidence: "curl -H Authorization: secret" }],
        },
      },
    },
    ["releaseCode"],
  )
  expect(sanitized).toEqual({
    request: { arguments: { releaseCode: "[敏感内容已隐藏]", path: "source.ts" } },
    decision: { assessment: { details: "[敏感内容已隐藏]", findings: [{ evidence: "[敏感内容已隐藏]" }] } },
  })
})

test("权限记录保留授权状态并隐藏授权参数和评估详情", () => {
  expect(
    sanitizePermissionAuditPayload({
      type: "authorized",
      authorization: {
        type: "allow",
        source: "human",
        arguments: { path: "source.ts", content: "源码正文" },
        assessment: { reason: "允许", details: { patch: "完整 diff" } },
      },
    }),
  ).toEqual({
    type: "authorized",
    authorization: {
      type: "allow",
      source: "human",
      arguments: { path: "source.ts", content: "[敏感内容已隐藏]" },
      assessment: { reason: "允许", details: "[敏感内容已隐藏]" },
    },
  })
})
