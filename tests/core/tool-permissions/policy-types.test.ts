import { describe, expect } from "bun:test"
import {
  builtinPermissionPolicies,
  configurablePermissionKeys,
  permissionDispositions,
  permissionReviewModes,
  permissionTags,
} from "../../../packages/core/tool-permissions/policy-types.ts"
import { createDiagnosticTest } from "../../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

describe("权限策略基础类型", () => {
  test("标签集合固定且 violation 不进入可配置策略键", () => {
    expect(permissionTags).toEqual([
      "read-workspace",
      "read-home",
      "read-system",
      "read-sensitive",
      "edit-workspace",
      "edit-home",
      "edit-system",
      "edit-sensitive",
      "network-fetch",
      "network-send",
      "system-change",
      "violation",
    ])
    expect(configurablePermissionKeys).toContain("unknown")
    expect(configurablePermissionKeys).not.toContain("violation")
  })

  test("处置档位和审核方式使用规格中的稳定标识", () => {
    expect(permissionDispositions).toEqual(["allow", "aiReview", "needHumanReview", "deny"])
    expect(permissionReviewModes).toEqual(["manual", "aiReview", "aiReviewWithAbstain", "autoApprove", "autoDeny"])
  })

  test("内置预设逐项定义全部策略键", () => {
    expect(builtinPermissionPolicies.plan.dispositions).toEqual({
      "read-workspace": "allow",
      "read-home": "aiReview",
      "read-system": "aiReview",
      "read-sensitive": "needHumanReview",
      "edit-workspace": "deny",
      "edit-home": "deny",
      "edit-system": "deny",
      "edit-sensitive": "deny",
      "network-fetch": "aiReview",
      "network-send": "deny",
      "system-change": "deny",
      unknown: "needHumanReview",
    })
    expect(Object.keys(builtinPermissionPolicies.edit.dispositions).sort()).toEqual(
      [...configurablePermissionKeys].sort(),
    )
    expect(Object.values(builtinPermissionPolicies["all-right"].dispositions)).toEqual(
      configurablePermissionKeys.map(() => "allow"),
    )
  })
})
