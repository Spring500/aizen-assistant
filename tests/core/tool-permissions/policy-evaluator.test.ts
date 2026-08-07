import { describe, expect, test } from "bun:test"
import { evaluatePermissionPolicy } from "../../../packages/core/tool-permissions/policy-evaluator.ts"
import {
  builtinPermissionPolicies,
  type PermissionPolicy,
} from "../../../packages/core/tool-permissions/policy-types.ts"

describe("权限策略求值", () => {
  test("violation 固定拒绝且不受预设影响", () => {
    expect(
      evaluatePermissionPolicy(
        { kind: "claims", claims: [{ tag: "violation", reason: "尝试修改权限系统配置" }] },
        builtinPermissionPolicies["all-right"],
      ),
    ).toEqual({
      disposition: "deny",
      decisiveKey: "violation",
      claims: [{ tag: "violation", reason: "尝试修改权限系统配置" }],
    })
  })

  test("unknown 使用策略表中的独立配置", () => {
    expect(evaluatePermissionPolicy({ kind: "unknown" }, builtinPermissionPolicies.edit)).toEqual({
      disposition: "needHumanReview",
      decisiveKey: "unknown",
      claims: [],
    })
  })

  test("空 claims 是正面担保并直接放行", () => {
    expect(evaluatePermissionPolicy({ kind: "claims", claims: [] }, builtinPermissionPolicies.plan)).toEqual({
      disposition: "allow",
      claims: [],
    })
  })

  test("多分类器 claims 合并后按最严标签处置", () => {
    expect(
      evaluatePermissionPolicy(
        {
          kind: "claims",
          claims: [
            { tag: "network-fetch", reason: "从 npm registry 下载依赖" },
            { tag: "edit-workspace", reason: "写入工作区依赖目录和锁文件" },
          ],
        },
        builtinPermissionPolicies.plan,
      ),
    ).toEqual({
      disposition: "deny",
      decisiveKey: "edit-workspace",
      claims: [
        { tag: "network-fetch", reason: "从 npm registry 下载依赖" },
        { tag: "edit-workspace", reason: "写入工作区依赖目录和锁文件" },
      ],
    })
  })

  test("策略缺失标签时按必须人工兜底", () => {
    const incomplete = {
      version: 1,
      preset: "custom",
      dispositions: { "read-workspace": "allow" },
    } as unknown as PermissionPolicy
    expect(
      evaluatePermissionPolicy({ kind: "claims", claims: [{ tag: "network-send", reason: "上传包" }] }, incomplete),
    ).toMatchObject({ disposition: "needHumanReview", decisiveKey: "network-send" })
  })
})
