import { describe, expect } from "bun:test"
import { createDiagnosticTest } from "../../utils/diagnostic-test.ts"
import { ToolPermissionManager } from "../../../packages/core/tool-permissions/manager.ts"
import { ToolPermissionRegistry } from "../../../packages/core/tool-permissions/registry.ts"
import type {
  AiPermissionReviewer,
  HumanPermissionReviewer,
  ToolPermissionDecision,
  ToolPermissionRequest,
} from "../../../packages/core/tool-permissions/types.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

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

const assessment = { summary: "动作", targets: [], reason: "测试" }

describe("ToolPermissionManager", () => {
  test("完全开放模式不启用收集器时不调用验证器", async () => {
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
    expect((await allowed.manager.authorize(base)).reviewSteps).toBeUndefined()
    const escalated = setup(decision, "needHumanReview")
    expect(await escalated.manager.authorize(base)).toMatchObject({ type: "allow", source: "human" })
    expect(escalated.humanCalls).toHaveLength(1)
  })

  test("人工审核不会自动过期，只在显式中止后结束等待", async () => {
    const registry = new ToolPermissionRegistry()
    registry.register({ toolName: "demo", validate: async () => ({ type: "needHumanReview", assessment }) })
    let reviewStarted = false
    const manager = new ToolPermissionManager({
      registry,
      aiReviewer: { review: async () => ({ type: "allow", reason: "不应调用" }) },
      humanReviewer: {
        review: async (_request, signal) => {
          reviewStarted = true
          return new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("已中止")), { once: true })
          })
        },
      },
    })
    const controller = new AbortController()
    let settled = false
    const authorization = manager.authorize(base, controller.signal).finally(() => {
      settled = true
    })
    for (let attempt = 0; attempt < 20 && !reviewStarted; attempt++) await Bun.sleep(1)
    expect(reviewStarted).toBe(true)
    await Bun.sleep(20)
    expect(settled).toBe(false)
    controller.abort()
    expect(await authorization).toMatchObject({ type: "aborted" })
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

  test("完全开放模式等待验证器并只记录缺口后自动放行原始参数", async () => {
    const registry = new ToolPermissionRegistry()
    const calls: string[] = []
    registry.register({
      toolName: "demo",
      validate: async () => {
        await Bun.sleep(5)
        calls.push("validated")
        return {
          type: "deny",
          reason: "影子拒绝",
          assessment: {
            ...assessment,
            normalizedArguments: { value: 2 },
            coverageGaps: [{ code: "demo.rule-miss", kind: "rule-miss" as const, summary: "演示规则未覆盖" }],
          },
        }
      },
    })
    const records: unknown[] = []
    const manager = new ToolPermissionManager({
      registry,
      aiReviewer: {
        review: async () => {
          throw new Error("完全开放模式不应调用AI")
        },
      },
      humanReviewer: {
        review: async () => {
          throw new Error("完全开放模式不应调用人工")
        },
      },
      gapRecorder: {
        record: async (record) => {
          calls.push("recorded")
          records.push(record)
        },
      },
    })
    expect(await manager.authorize({ ...base, mode: "unrestricted" })).toMatchObject({
      type: "allow",
      source: "mode",
      arguments: { value: 1 },
    })
    expect(calls).toEqual(["validated", "recorded"])
    expect(records).toMatchObject([
      {
        permissionMode: "unrestricted",
        validatorDecision: "deny",
        gaps: [{ code: "demo.rule-miss" }],
        arguments: { value: 1 },
      },
    ])
  })

  test("普通模式复用验证结果记录缺口且不重复验证", async () => {
    const registry = new ToolPermissionRegistry()
    let validations = 0
    registry.register({
      toolName: "demo",
      validate: async () => {
        validations++
        return {
          type: "allow",
          assessment: {
            ...assessment,
            coverageGaps: [{ code: "demo.coarse", kind: "coarse-rule" as const, summary: "规则较粗" }],
          },
        }
      },
    })
    const records: unknown[] = []
    const manager = new ToolPermissionManager({
      registry,
      aiReviewer: { review: async () => ({ type: "allow", reason: "不应调用" }) },
      humanReviewer: { review: async (request) => ({ batchId: request.batchId, answers: [] }) },
      gapRecorder: { record: async (record) => void records.push(record) },
    })
    expect(await manager.authorize(base)).toMatchObject({ type: "allow", source: "validator" })
    expect(validations).toBe(1)
    expect(records).toHaveLength(1)
  })

  test("Bash记录完整命令，文件工具只记录内容规模", async () => {
    const registry = new ToolPermissionRegistry()
    const gap = { code: "demo.gap", kind: "rule-miss" as const, summary: "测试缺口" }
    registry.register({
      toolName: "bash",
      validate: async () => ({ type: "allow", assessment: { ...assessment, coverageGaps: [gap] } }),
    })
    registry.register({
      toolName: "write",
      validate: async () => ({ type: "allow", assessment: { ...assessment, coverageGaps: [gap] } }),
    })
    const records: Array<{ toolName: string; arguments: unknown }> = []
    const manager = new ToolPermissionManager({
      registry,
      aiReviewer: { review: async () => ({ type: "allow", reason: "不应调用" }) },
      humanReviewer: { review: async (request) => ({ batchId: request.batchId, answers: [] }) },
      gapRecorder: {
        record: async (record) => void records.push({ toolName: record.toolName, arguments: record.arguments }),
      },
    })
    await manager.authorize({ ...base, toolName: "bash", arguments: { command: "find ." } })
    await manager.authorize({
      ...base,
      toolName: "write",
      arguments: { path: "secret.ts", content: "不要写入记录" },
    })
    expect(records).toEqual([
      { toolName: "bash", arguments: { command: "find ." } },
      {
        toolName: "write",
        arguments: { path: "secret.ts", contentCharacters: 6, contentLines: 1 },
      },
    ])
  })

  test("完全开放模式在验证器缺失、异常和记录失败时仍自动放行", async () => {
    const errors: string[] = []
    const missing = new ToolPermissionManager({
      registry: new ToolPermissionRegistry(),
      aiReviewer: { review: async () => ({ type: "deny", reason: "不应调用" }) },
      humanReviewer: { review: async (request) => ({ batchId: request.batchId, answers: [] }) },
      gapRecorder: { record: async () => {} },
    })
    expect(await missing.authorize({ ...base, mode: "unrestricted" })).toMatchObject({ type: "allow", source: "mode" })

    const registry = new ToolPermissionRegistry()
    registry.register({ toolName: "demo", validate: async () => Promise.reject(new Error("验证失败")) })
    const broken = new ToolPermissionManager({
      registry,
      aiReviewer: { review: async () => ({ type: "deny", reason: "不应调用" }) },
      humanReviewer: { review: async (request) => ({ batchId: request.batchId, answers: [] }) },
      gapRecorder: { record: async () => Promise.reject(new Error("磁盘失败")) },
      reportGapRecordingError: (error) => errors.push(error.message),
    })
    expect(await broken.authorize({ ...base, mode: "unrestricted" })).toMatchObject({ type: "allow", source: "mode" })
    expect(errors).toEqual(["磁盘失败"])
  })
})
