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
  let humanDecision: { type: "approve" } | { type: "deny"; reason?: string } = { type: "approve" }
  const aiRequests: unknown[] = []
  const ai: AiPermissionReviewer = {
    review: async (request) => {
      aiRequests.push(request)
      return aiType === "allow"
        ? { type: "allow", reason: "风险可接受" }
        : aiType === "deny"
          ? { type: "deny", reason: "风险过高" }
          : { type: "needHumanReview", reason: "需要用户判断" }
    },
  }
  const human: HumanPermissionReviewer = {
    review: async (request) => {
      humanCalls.push(request)
      return {
        batchId: request.batchId,
        answers: request.requests.map((item) => ({ requestId: item.requestId, ...humanDecision })),
      }
    },
  }
  return {
    manager: new ToolPermissionManager({ registry, aiReviewer: ai, humanReviewer: human }),
    humanCalls,
    aiRequests,
    setHumanDecision(decision: typeof humanDecision) {
      humanDecision = decision
    },
  }
}

const assessment = { summary: "动作", targets: [], risk: "low" as const, reason: "测试", findings: [] }

describe("ToolPermissionManager", () => {
  test("完全开放模式不调用验证器", async () => {
    const registry = new ToolPermissionRegistry()
    const manager = new ToolPermissionManager({
      registry,
      aiReviewer: { review: async () => ({ type: "deny", reason: "不应调用" }) },
      humanReviewer: {
        review: async (request) => ({
          batchId: request.batchId,
          answers: request.requests.map((item) => ({ requestId: item.requestId, type: "deny" as const })),
        }),
      },
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

  test("发送给AI的正文和密钥字段会被隐藏", async () => {
    const decision = {
      type: "needAiReview",
      assessment,
      reviewPayload: { content: "源码正文", apiKey: "secret", path: "file.ts" },
    } as const
    const setupResult = setup(decision)
    await setupResult.manager.authorize(base)
    expect(setupResult.aiRequests).toMatchObject([
      { payload: { content: "[敏感内容已隐藏]", apiKey: "[敏感内容已隐藏]", path: "file.ts" } },
    ])
  })

  test("第三方验证器额外敏感字段不会发送给AI", async () => {
    const registry = new ToolPermissionRegistry()
    registry.register({
      toolName: "demo",
      sensitiveFields: ["releaseCode"],
      validate: async () => ({
        type: "needAiReview",
        assessment,
        reviewPayload: { releaseCode: "REAL-SECRET", path: "release.json" },
      }),
    })
    const requests: unknown[] = []
    const manager = new ToolPermissionManager({
      registry,
      aiReviewer: {
        review: async (request) => {
          requests.push(request)
          return { type: "allow", reason: "允许" }
        },
      },
      humanReviewer: {
        review: async (request) => ({ batchId: request.batchId, answers: [] }),
      },
    })
    await manager.authorize(base)
    expect(requests).toMatchObject([{ payload: { releaseCode: "[敏感内容已隐藏]", path: "release.json" } }])
  })

  test("人工无理由拒绝使用明确英文格式", async () => {
    const result = setup({ type: "needHumanReview", assessment })
    result.setHumanDecision({ type: "deny" })
    expect(await result.manager.authorize(base)).toMatchObject({
      type: "deny",
      reason: "Operation denied: User denied permission without providing a reason.",
    })
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

  test("批次只把最终需要人工判断的调用交给用户并统一提交", async () => {
    const registry = new ToolPermissionRegistry()
    registry.register({
      toolName: "automatic",
      validate: async () => ({ type: "allow", assessment }),
    })
    registry.register({
      toolName: "manual",
      validate: async () => ({ type: "needHumanReview", assessment }),
    })
    const humanCalls: Array<{ requests: Array<{ toolName: string; requestId: string }>; batchId: string }> = []
    const manager = new ToolPermissionManager({
      registry,
      aiReviewer: { review: async () => ({ type: "allow", reason: "不应调用" }) },
      humanReviewer: {
        review: async (request) => {
          humanCalls.push(request)
          return {
            batchId: request.batchId,
            answers: request.requests.map((item) => ({ requestId: item.requestId, type: "deny" as const })),
          }
        },
      },
    })
    const result = await manager.authorizeBatch({
      batchId: "batch",
      calls: [
        { ...base, toolCallId: "automatic", toolName: "automatic" },
        { ...base, toolCallId: "manual", toolName: "manual" },
      ],
    })
    expect(humanCalls).toHaveLength(1)
    expect(humanCalls[0]?.requests.map((request) => request.toolName)).toEqual(["manual"])
    expect(result.authorizations).toMatchObject([
      { toolCallId: "automatic", authorization: { type: "allow", source: "validator" } },
      { toolCallId: "manual", authorization: { type: "deny", source: "human" } },
    ])
  })

  test("纯AI模式拒绝所有人工分支", async () => {
    const { manager, humanCalls } = setup({ type: "needHumanReview", assessment })
    expect(await manager.authorize({ ...base, mode: "aiOnly" })).toMatchObject({ type: "deny", source: "system" })
    expect(humanCalls).toHaveLength(0)
  })
})
