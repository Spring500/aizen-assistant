import type { PermissionClassifierRegistry } from "./classifier-registry.ts"
import type { PermissionClassifyContext, PermissionClassifyInput } from "./classifier-types.ts"
import { evaluatePermissionPolicy, type PermissionPolicyEvaluation } from "./policy-evaluator.ts"
import type { PermissionPolicy, PermissionReviewMode } from "./policy-types.ts"
import { resolvePermissionDisposition } from "./review-router.ts"
import type { AiPermissionReviewer, HumanPermissionReviewer, HumanReviewRequest, ToolAuthorization } from "./types.ts"

export type PolicyPermissionRequest = PermissionClassifyInput & {
  sessionId: string
  turnId: string
  toolCallId: string
  declaredIntent: string
}

export type PolicyPermissionManagerOptions = {
  registry: PermissionClassifierRegistry
  aiReviewer: AiPermissionReviewer
  humanReviewer: HumanPermissionReviewer
  now?: () => Date
}

function assessment(evaluation: PermissionPolicyEvaluation) {
  return {
    summary: evaluation.decisiveKey ?? "无需标注的行为",
    targets: [],
    risk: evaluation.disposition === "deny" ? ("critical" as const) : ("medium" as const),
    reason:
      evaluation.claims
        .map((claim) => claim.reason)
        .filter(Boolean)
        .join("；") || "分类器正面担保无需标注",
    findings: evaluation.claims.map((claim) => ({
      severity: evaluation.disposition === "deny" ? ("critical" as const) : ("medium" as const),
      category: claim.tag,
      summary: claim.tag,
      evidence: claim.reason ?? claim.tag,
    })),
  }
}

export class PolicyPermissionManager {
  readonly #registry: PermissionClassifierRegistry
  readonly #aiReviewer: AiPermissionReviewer
  readonly #humanReviewer: HumanPermissionReviewer
  readonly #now: () => Date

  constructor(options: PolicyPermissionManagerOptions) {
    this.#registry = options.registry
    this.#aiReviewer = options.aiReviewer
    this.#humanReviewer = options.humanReviewer
    this.#now = options.now ?? (() => new Date())
  }

  /** 依次执行分类、策略求值和审核路由，返回可直接用于工具包装器的授权结果。 */
  async authorize(
    request: PolicyPermissionRequest,
    context: PermissionClassifyContext,
    policy: PermissionPolicy,
    reviewMode: PermissionReviewMode,
    signal?: AbortSignal,
  ): Promise<ToolAuthorization> {
    const classification = await this.#registry.classify(request, context)
    const evaluation = evaluatePermissionPolicy(classification, policy)
    const analyzed = assessment(evaluation)
    const route = resolvePermissionDisposition(evaluation.disposition, reviewMode)
    if (route === "allow")
      return {
        type: "allow",
        arguments: request.arguments,
        assessment: analyzed,
        source: evaluation.disposition === "allow" ? "policy" : "reviewMode",
      } as ToolAuthorization
    if (route === "deny")
      return {
        type: "deny",
        reason: `Operation denied: rule "${evaluation.decisiveKey ?? "permission policy"}" is not allowed.`,
        assessment: analyzed,
        source: "policy",
      } as ToolAuthorization
    if (route === "ai" || route === "aiWithAbstain") {
      const result = await this.#aiReviewer.review(
        {
          toolName: request.toolName,
          declaredIntent: request.declaredIntent,
          cwd: request.cwd,
          validatorDecision: "needAiReview",
          assessment: analyzed,
          payload: { arguments: request.arguments, claims: evaluation.claims },
        },
        signal,
      )
      if (result.type === "allow")
        return { type: "allow", arguments: request.arguments, assessment: analyzed, source: "ai" }
      if (result.type === "deny" || route === "ai")
        return { type: "deny", reason: result.reason, assessment: analyzed, source: "ai" }
    }
    return this.#human(request, evaluation, analyzed, signal)
  }

  async #human(
    request: PolicyPermissionRequest,
    evaluation: PermissionPolicyEvaluation,
    analyzed: ReturnType<typeof assessment>,
    signal?: AbortSignal,
  ): Promise<ToolAuthorization> {
    const review: HumanReviewRequest = {
      requestId: crypto.randomUUID(),
      batchId: crypto.randomUUID(),
      sessionId: request.sessionId,
      turnId: request.turnId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      declaredIntent: request.declaredIntent,
      cwd: request.cwd,
      arguments: request.arguments,
      assessment: analyzed,
      createdAt: this.#now().toISOString(),
    }
    const decision = await this.#humanReviewer.review(
      {
        batchId: review.batchId,
        sessionId: request.sessionId,
        turnId: request.turnId,
        requests: [review],
        createdAt: review.createdAt,
      },
      signal,
    )
    const answer = decision.answers.find((item) => item.requestId === review.requestId)
    if (answer?.type === "approve")
      return { type: "allow", arguments: request.arguments, assessment: analyzed, source: "human" }
    return {
      type: "deny",
      reason: answer?.reason
        ? `Operation denied: rule "${evaluation.decisiveKey ?? "permission policy"}" requires human approval and was denied.\nUser reason: ${answer.reason}`
        : `Operation denied: rule "${evaluation.decisiveKey ?? "permission policy"}" requires human approval and was denied.`,
      assessment: analyzed,
      source: "human",
    }
  }
}
