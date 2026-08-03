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
