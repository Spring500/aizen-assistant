import { describe, expect } from "bun:test"
import { resolvePermissionDisposition } from "../../../packages/core/tool-permissions/review-router.ts"
import { createDiagnosticTest } from "../../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const modes = ["manual", "aiReview", "aiReviewWithAbstain", "autoApprove", "autoDeny"] as const

describe("权限审核方式路由", () => {
  test("allow 和 deny 不受审核方式影响", () => {
    for (const mode of modes) {
      expect(resolvePermissionDisposition("allow", mode)).toBe("allow")
      expect(resolvePermissionDisposition("deny", mode)).toBe("deny")
    }
  })

  test("aiReview 按审核方式路由", () => {
    expect(modes.map((mode) => resolvePermissionDisposition("aiReview", mode))).toEqual([
      "human",
      "ai",
      "aiWithAbstain",
      "allow",
      "deny",
    ])
  })

  test("needHumanReview 永远不交给 AI", () => {
    expect(modes.map((mode) => resolvePermissionDisposition("needHumanReview", mode))).toEqual([
      "human",
      "human",
      "human",
      "allow",
      "deny",
    ])
  })
})
