import { describe, expect, test } from "bun:test"
import { ToolPermissionManager } from "../../../packages/core/tool-permissions/manager.ts"
import { ToolPermissionRegistry } from "../../../packages/core/tool-permissions/registry.ts"
import type {
  AiPermissionReviewer,
  HumanPermissionReviewer,
  ToolPermissionDecision,
  ToolPermissionRequest,
} from "../../../packages/core/tool-permissions/types.ts"

const base: ToolPermissionRequest = {
  sessionId: "session",
  turnId: "turn",
  toolCallId: "call",
  toolName: "demo",
  arguments: { value: 1 },
  declaredIntent: "验证权限流程",
  cwd: "/project",
  mode: "hybrid",
}

function setup(decision: ToolPermissionDecision, aiType: "allow" | "deny" | "needHumanReview" = "allow") {
  const registry = new ToolPermissionRegistry()
  registry.register({ toolName: "demo", validate: async () => decision })
  const humanCalls: unknown[] = []
  const ai: AiPermissionReviewer = {
    review: async () =>
      aiType === "allow"
        ? { type: "allow", reason: "风险可接受" }
        : aiType === "deny"
          ? { type: "deny", reason: "风险过高" }
          : { type: "needHumanReview", reason: "需要用户判断" },
  }
  const human: HumanPermissionReviewer = {
    review: async (request) => {
      humanCalls.push(request)
      return { type: "approve" }
    },
  }
  return { manager: new ToolPermissionManager({ registry, aiReviewer: ai, humanReviewer: human }), humanCalls }
}

const assessment = { summary: "动作", targets: [], risk: "low" as const, reason: "测试" }

describe("ToolPermissionManager", () => {
  test("完全开放模式不调用验证器", async () => {
    const registry = new ToolPermissionRegistry()
    const manager = new ToolPermissionManager({
      registry,
      aiReviewer: { review: async () => ({ type: "deny", reason: "不应调用" }) },
      humanReviewer: { review: async () => ({ type: "deny" }) },
    })
    expect(await manager.authorize({ ...base, mode: "unrestricted" })).toMatchObject({ type: "allow", source: "mode" })
  })

  test("固定拒绝不能被人工覆盖", async () => {
    const { manager, humanCalls } = setup({ type: "deny", reason: "硬拒绝", assessment })
    expect(await manager.authorize(base)).toMatchObject({ type: "deny", source: "validator", reason: "硬拒绝" })
    expect(humanCalls).toHaveLength(0)
  })

  test("AI允许后执行，AI要求人工时进入人工", async () => {
    const decision = { type: "needAiReview", assessment, reviewPayload: { token: "secret", value: "safe" } } as const
    const allowed = setup(decision, "allow")
    expect(await allowed.manager.authorize(base)).toMatchObject({ type: "allow", source: "ai" })
    const escalated = setup(decision, "needHumanReview")
    expect(await escalated.manager.authorize(base)).toMatchObject({ type: "allow", source: "human" })
    expect(escalated.humanCalls).toHaveLength(1)
  })

  test("确认拒绝模式把AI拒绝交给人工", async () => {
    const decision = { type: "needAiReview", assessment, reviewPayload: {} } as const
    const normal = setup(decision, "deny")
    expect(await normal.manager.authorize(base)).toMatchObject({ type: "deny", source: "ai" })
    const confirm = setup(decision, "deny")
    expect(await confirm.manager.authorize({ ...base, mode: "hybridConfirmDenials" })).toMatchObject({
      type: "allow",
      source: "human",
    })
  })

  test("纯AI模式拒绝所有人工分支", async () => {
    const { manager, humanCalls } = setup({ type: "needHumanReview", assessment })
    expect(await manager.authorize({ ...base, mode: "aiOnly" })).toMatchObject({ type: "deny", source: "system" })
    expect(humanCalls).toHaveLength(0)
  })
})
