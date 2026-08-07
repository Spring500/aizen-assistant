import { describe, expect } from "bun:test"
import { PermissionClassifierRegistry } from "../../../packages/core/tool-permissions/classifier-registry.ts"
import { PolicyPermissionManager } from "../../../packages/core/tool-permissions/policy-manager.ts"
import { builtinPermissionPolicies } from "../../../packages/core/tool-permissions/policy-types.ts"
import { createDiagnosticTest } from "../../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const request = {
  sessionId: "session",
  turnId: "turn",
  toolCallId: "call",
  toolName: "demo",
  arguments: {},
  declaredIntent: "执行演示操作",
  cwd: "/project",
}
const context = {
  workspaceRoot: "/project",
  sensitivePaths: [],
  shell: "bash",
  platform: "linux",
}

function setup(tags: Array<"edit-workspace" | "network-fetch" | "read-sensitive" | "violation">) {
  const registry = new PermissionClassifierRegistry()
  registry.registerBuiltin({
    id: "builtin/demo@1",
    toolNames: ["demo"],
    classify: () => ({ kind: "claims", claims: tags.map((tag) => ({ tag, reason: `命中 ${tag}` })) }),
  })
  const calls: string[] = []
  const manager = new PolicyPermissionManager({
    registry,
    aiReviewer: {
      review: async () => {
        calls.push("ai")
        return { type: "allow", reason: "允许" }
      },
    },
    humanReviewer: {
      review: async (batch) => {
        calls.push("human")
        return {
          batchId: batch.batchId,
          answers: batch.requests.map((item) => ({ requestId: item.requestId, type: "approve" as const })),
        }
      },
    },
  })
  return { manager, calls }
}

describe("策略权限管理器", () => {
  test("plan 下 npm 类复合标签按修改工作区直接拒绝", async () => {
    const { manager, calls } = setup(["network-fetch", "edit-workspace"])
    expect(
      await manager.authorize(request, context, builtinPermissionPolicies.plan, "aiReviewWithAbstain"),
    ).toMatchObject({ type: "deny", source: "policy" })
    expect(calls).toEqual([])
  })

  test("AI 不介入必须人工档", async () => {
    const { manager, calls } = setup(["read-sensitive"])
    expect(await manager.authorize(request, context, builtinPermissionPolicies.edit, "aiReview")).toMatchObject({
      type: "allow",
      source: "human",
    })
    expect(calls).toEqual(["human"])
  })

  test("autoApprove 覆盖必须人工但不能覆盖 violation", async () => {
    const sensitive = setup(["read-sensitive"])
    expect(
      await sensitive.manager.authorize(request, context, builtinPermissionPolicies.edit, "autoApprove"),
    ).toMatchObject({ type: "allow", source: "reviewMode" })
    const violation = setup(["violation"])
    expect(
      await violation.manager.authorize(request, context, builtinPermissionPolicies["all-right"], "autoApprove"),
    ).toMatchObject({ type: "deny", source: "policy" })
  })

  test("同一批次的人工项统一展示和提交", async () => {
    const registry = new PermissionClassifierRegistry()
    registry.registerBuiltin({
      id: "builtin/demo@1",
      toolNames: ["demo"],
      classify: () => ({
        kind: "claims",
        claims: [{ tag: "read-sensitive", reason: "读取敏感文件" }],
      }),
    })
    const batches: number[] = []
    const manager = new PolicyPermissionManager({
      registry,
      aiReviewer: { review: async () => ({ type: "allow", reason: "不应调用" }) },
      humanReviewer: {
        review: async (batch) => {
          batches.push(batch.requests.length)
          return {
            batchId: batch.batchId,
            answers: batch.requests.map((item) => ({ requestId: item.requestId, type: "approve" as const })),
          }
        },
      },
    })
    const result = await manager.authorizeBatch(
      {
        batchId: "batch",
        calls: [
          { ...request, toolCallId: "one", mode: "hybrid" },
          { ...request, toolCallId: "two", mode: "hybrid" },
        ],
      },
      context,
      builtinPermissionPolicies.edit,
      "manual",
    )
    expect(batches).toEqual([2])
    expect(result.authorizations.map((item) => item.authorization.type)).toEqual(["allow", "allow"])
  })

  test("全员弃权按 unknown 策略处理", async () => {
    const registry = new PermissionClassifierRegistry()
    const manager = new PolicyPermissionManager({
      registry,
      aiReviewer: { review: async () => ({ type: "allow", reason: "不应调用" }) },
      humanReviewer: {
        review: async (batch) => ({
          batchId: batch.batchId,
          answers: batch.requests.map((item) => ({ requestId: item.requestId, type: "deny" as const })),
        }),
      },
    })
    expect(await manager.authorize(request, context, builtinPermissionPolicies.edit, "manual")).toMatchObject({
      type: "deny",
      source: "human",
    })
  })
})
