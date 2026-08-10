import type { PermissionClassifierRegistry } from "./classifier-registry.ts"
import type { PermissionClassifyContext, PermissionClassifyInput } from "./classifier-types.ts"
import { evaluatePermissionPolicy, type PermissionPolicyEvaluation } from "./policy-evaluator.ts"
import {
  permissionRuleName,
  permissionTagNames,
  type PermissionPolicy,
  type PermissionReviewMode,
} from "./policy-types.ts"
import { resolvePermissionDisposition } from "./review-router.ts"
import type {
  AiPermissionReviewer,
  HumanPermissionReviewer,
  HumanReviewRequest,
  PermissionAuditEvent,
  ToolAuthorization,
  ToolPermissionBatchAuthorization,
  ToolPermissionBatchRequest,
} from "./types.ts"

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
  /** 授权与人工审核过程的审计事件回调。 */
  audit?: (event: PermissionAuditEvent) => void | Promise<void>
  now?: () => Date
}

function assessment(evaluation: PermissionPolicyEvaluation) {
  // unknown：分类器无法做出任何陈述，需人工判断。与“正面担保”语义相反，必须单独文案。
  if (evaluation.kind === "unknown") {
    return {
      summary: "Unclassifiable",
      targets: [],
      reason: "Classifiers cannot determine the risk; manual review required.",
      tags: [],
      unclassified: true,
    }
  }
  const tags = evaluation.claims.map((claim) => ({
    tag: claim.tag,
    name: permissionTagNames[claim.tag] ?? claim.tag,
    ...(claim.reason ? { evidence: claim.reason } : {}),
  }))
  // 声称缺理由时用标签可读名兜底；claims 为空即正面担保，仅审计文案。
  const reason =
    evaluation.claims
      .map((claim) => claim.reason ?? permissionTagNames[claim.tag] ?? claim.tag)
      .filter(Boolean)
      .join("；") || "Classifiers found no notable behavior to flag."
  return {
    summary: permissionRuleName(evaluation.decisiveKey) ?? "无需标注的行为",
    targets: [],
    reason,
    tags,
  }
}

export class PolicyPermissionManager {
  readonly #registry: PermissionClassifierRegistry
  readonly #aiReviewer: AiPermissionReviewer
  readonly #humanReviewer: HumanPermissionReviewer
  readonly #audit: (event: PermissionAuditEvent) => void | Promise<void>
  readonly #now: () => Date

  constructor(options: PolicyPermissionManagerOptions) {
    this.#registry = options.registry
    this.#aiReviewer = options.aiReviewer
    this.#humanReviewer = options.humanReviewer
    this.#audit = options.audit ?? (() => {})
    this.#now = options.now ?? (() => new Date())
  }

  /** 对同一工具批次完成分类和自动审核，并将全部人工项合并为一次提交。 */
  async authorizeBatch(
    batch: ToolPermissionBatchRequest,
    context: PermissionClassifyContext,
    policy: PermissionPolicy,
    reviewMode: PermissionReviewMode,
    signal?: AbortSignal,
  ): Promise<ToolPermissionBatchAuthorization> {
    for (const request of batch.calls)
      await this.#record({ type: "permissionRequested", request, batchId: batch.batchId, at: this.#timestamp() })
    const prepared = await Promise.all(
      batch.calls.map(async (request) => {
        const classification = await this.#registry.classify(request, context)
        const evaluation = evaluatePermissionPolicy(classification, policy)
        const analyzed = assessment(evaluation)
        const route = resolvePermissionDisposition(evaluation.disposition, reviewMode)
        if (route === "human") return { request, evaluation, analyzed }
        return {
          request,
          evaluation,
          analyzed,
          authorization: await this.#automatic(request, evaluation, analyzed, route, signal),
        }
      }),
    )
    const humanItems = prepared.filter((item) => item.authorization === undefined)
    const human = humanItems.length > 0 ? await this.#humanBatch(batch.batchId, humanItems, signal) : new Map()
    const authorizations = prepared.map((item) => ({
      toolCallId: item.request.toolCallId,
      authorization: item.authorization ??
        human.get(item.request.toolCallId) ?? {
          type: "deny",
          reason: "Operation denied: Permission review returned no result.",
          source: "system",
        },
    }))
    for (const item of prepared) {
      const authorization = authorizations.find((entry) => entry.toolCallId === item.request.toolCallId)
      if (authorization)
        await this.#record({
          type: "authorized",
          request: item.request,
          batchId: batch.batchId,
          authorization: authorization.authorization,
          at: this.#timestamp(),
        })
    }
    return { batchId: batch.batchId, authorizations }
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
    if (route === "human") return this.#human(request, evaluation, analyzed, signal)
    return this.#automatic(request, evaluation, analyzed, route, signal)
  }

  async #automatic(
    request: PolicyPermissionRequest,
    evaluation: PermissionPolicyEvaluation,
    analyzed: ReturnType<typeof assessment>,
    route: Exclude<ReturnType<typeof resolvePermissionDisposition>, "human">,
    signal?: AbortSignal,
  ): Promise<ToolAuthorization> {
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
        reason: `Operation denied: rule "${permissionRuleName(evaluation.decisiveKey) ?? "permission policy"}" is not allowed.`,
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

  async #humanBatch(
    batchId: string,
    items: Array<{
      request: PolicyPermissionRequest
      evaluation: PermissionPolicyEvaluation
      analyzed: ReturnType<typeof assessment>
    }>,
    signal?: AbortSignal,
  ): Promise<Map<string, ToolAuthorization>> {
    const createdAt = this.#now().toISOString()
    const reviews = items.map(({ request, analyzed }) => ({
      requestId: crypto.randomUUID(),
      batchId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      declaredIntent: request.declaredIntent,
      cwd: request.cwd,
      arguments: request.arguments,
      assessment: analyzed,
      createdAt,
    }))
    const decision = await this.#humanReviewer.review(
      {
        batchId,
        sessionId: reviews[0]?.sessionId ?? "",
        turnId: reviews[0]?.turnId ?? "",
        requests: reviews,
        createdAt,
      },
      signal,
    )
    const answers = new Map(decision.answers.map((answer) => [answer.requestId, answer]))
    const results = new Map<string, ToolAuthorization>()
    for (const review of reviews) {
      const item = items.find((candidate) => candidate.request.toolCallId === review.toolCallId)
      const answer = answers.get(review.requestId)
      if (!item) continue
      if (answer?.type === "approve") {
        results.set(review.toolCallId, {
          type: "allow",
          arguments: item.request.arguments,
          assessment: item.analyzed,
          source: "human",
        })
      } else {
        results.set(review.toolCallId, {
          type: "deny",
          reason: answer?.reason
            ? `Operation denied: rule "${permissionRuleName(item.evaluation.decisiveKey) ?? "permission policy"}" requires human approval and was denied.\nUser reason: ${answer.reason}`
            : `Operation denied: rule "${permissionRuleName(item.evaluation.decisiveKey) ?? "permission policy"}" requires human approval and was denied.`,
          assessment: item.analyzed,
          source: "human",
        })
      }
    }
    return results
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
        ? `Operation denied: rule "${permissionRuleName(evaluation.decisiveKey) ?? "permission policy"}" requires human approval and was denied.\nUser reason: ${answer.reason}`
        : `Operation denied: rule "${permissionRuleName(evaluation.decisiveKey) ?? "permission policy"}" requires human approval and was denied.`,
      assessment: analyzed,
      source: "human",
    }
  }

  async #record(event: PermissionAuditEvent): Promise<void> {
    await this.#audit(event)
  }

  #timestamp(): string {
    return this.#now().toISOString()
  }
}
