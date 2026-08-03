import { sanitizeReviewPayload } from "./sanitizer.ts"
import type { ToolPermissionRegistry } from "./registry.ts"
import type {
  AiPermissionReviewer,
  AiReviewDecision,
  HumanPermissionReviewer,
  HumanReviewRequest,
  PermissionAuditEvent,
  ToolAssessment,
  ToolAuthorization,
  ToolPermissionBatchAuthorization,
  ToolPermissionBatchRequest,
  ToolPermissionDecision,
  ToolPermissionRequest,
} from "./types.ts"

export type ToolPermissionManagerOptions = {
  registry: ToolPermissionRegistry
  aiReviewer: AiPermissionReviewer
  humanReviewer: HumanPermissionReviewer
  audit?: (event: PermissionAuditEvent) => void | Promise<void>
  now?: () => Date
  humanReviewTimeoutMs?: number
}

type HumanReviewResolution =
  | { type: "approve" }
  | { type: "deny"; reason?: string }
  | { type: "aborted" }
  | { type: "system"; reason: string }

type PreparedAuthorization =
  | { type: "finished"; request: ToolPermissionRequest; authorization: ToolAuthorization }
  | {
      type: "human"
      request: ToolPermissionRequest
      assessment: ToolAssessment
      decision?: ToolPermissionDecision
      aiDecision?: Extract<AiReviewDecision, { type: "deny" | "needHumanReview" }>
      error?: string
    }

export class ToolPermissionManager {
  readonly #registry: ToolPermissionRegistry
  readonly #aiReviewer: AiPermissionReviewer
  readonly #humanReviewer: HumanPermissionReviewer
  readonly #audit: (event: PermissionAuditEvent) => void | Promise<void>
  readonly #now: () => Date
  readonly #humanReviewTimeoutMs: number

  constructor(options: ToolPermissionManagerOptions) {
    this.#registry = options.registry
    this.#aiReviewer = options.aiReviewer
    this.#humanReviewer = options.humanReviewer
    this.#audit = options.audit ?? (() => {})
    this.#now = options.now ?? (() => new Date())
    this.#humanReviewTimeoutMs = options.humanReviewTimeoutMs ?? 10 * 60 * 1000
  }

  /** 对一批已通过工具 Schema 校验的调用执行权限流程，并只把最终需要人工判断的调用交给用户。 */
  async authorizeBatch(
    batch: ToolPermissionBatchRequest,
    signal?: AbortSignal,
  ): Promise<ToolPermissionBatchAuthorization> {
    if (batch.calls.length === 0) return { batchId: batch.batchId, authorizations: [] }
    await this.#record({ type: "permissionBatchRequested", batch, at: this.#timestamp() })
    const prepared: PreparedAuthorization[] = []
    for (const request of batch.calls) {
      await this.#record({ type: "permissionRequested", request, batchId: batch.batchId, at: this.#timestamp() })
      if (signal?.aborted) {
        prepared.push({
          type: "finished",
          request,
          authorization: {
            type: "aborted",
            reason: "Operation aborted: User aborted the turn before execution started.",
          },
        })
        continue
      }
      prepared.push(await this.#prepare(request, batch.batchId, signal))
    }

    const humanItems = prepared.filter(
      (item): item is Extract<PreparedAuthorization, { type: "human" }> => item.type === "human",
    )
    const humanAnswers =
      humanItems.length > 0 ? await this.#reviewHumanBatch(batch.batchId, humanItems, signal) : new Map()
    const authorizations: ToolPermissionBatchAuthorization["authorizations"] = []
    for (const item of prepared) {
      const authorization = item.type === "finished" ? item.authorization : this.#humanAuthorization(item, humanAnswers)
      await this.#record({
        type: "authorized",
        request: item.request,
        batchId: batch.batchId,
        authorization,
        at: this.#timestamp(),
      })
      authorizations.push({ toolCallId: item.request.toolCallId, authorization })
    }
    const result = { batchId: batch.batchId, authorizations }
    await this.#record({ type: "permissionBatchAuthorized", batch: result, at: this.#timestamp() })
    return result
  }

  /** 兼容单工具调用方；新 adapter 应使用 authorizeBatch。 */
  async authorize(request: ToolPermissionRequest, signal?: AbortSignal): Promise<ToolAuthorization> {
    const result = await this.authorizeBatch({ batchId: crypto.randomUUID(), calls: [request] }, signal)
    return (
      result.authorizations[0]?.authorization ?? {
        type: "deny",
        source: "system",
        reason: "Operation denied: Permission review returned no result.",
      }
    )
  }

  async #prepare(
    request: ToolPermissionRequest,
    batchId: string,
    signal?: AbortSignal,
  ): Promise<PreparedAuthorization> {
    if (request.mode === "unrestricted") {
      return {
        type: "finished",
        request,
        authorization: {
          type: "allow",
          arguments: request.arguments,
          assessment: {
            summary: "完全开放模式",
            targets: [],
            risk: "low",
            reason: "当前会话允许直接执行工具",
            findings: [],
          },
          source: "mode",
        },
      }
    }

    const validator = this.#registry.get(request.toolName)
    if (!validator) return this.#humanOrDeny(request, undefined, "该工具没有权限验证器")

    let decision: ToolPermissionDecision
    try {
      decision = await validator.validate(request, signal)
    } catch (error) {
      return this.#humanOrDeny(
        request,
        undefined,
        `权限验证器异常：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    await this.#record({ type: "validated", request, batchId, decision, at: this.#timestamp() })

    if (decision.type === "deny")
      return {
        type: "finished",
        request,
        authorization: {
          type: "deny",
          reason: decision.reason,
          assessment: decision.assessment,
          source: "validator",
        },
      }
    if (decision.type === "allow")
      return {
        type: "finished",
        request,
        authorization: {
          type: "allow",
          arguments: decision.assessment.normalizedArguments ?? request.arguments,
          assessment: decision.assessment,
          source: "validator",
        },
      }
    if (decision.type === "needHumanReview") return this.#humanOrDeny(request, decision)

    try {
      const aiDecision = await this.#aiReviewer.review(
        {
          toolName: request.toolName,
          declaredIntent: request.declaredIntent,
          cwd: request.cwd,
          validatorDecision: "needAiReview",
          assessment: sanitizeReviewPayload(
            decision.assessment,
            validator.sensitiveFields,
          ) as typeof decision.assessment,
          payload: sanitizeReviewPayload(decision.reviewPayload, validator.sensitiveFields),
        },
        signal,
      )
      await this.#record({ type: "aiReviewed", request, batchId, decision: aiDecision, at: this.#timestamp() })
      if (aiDecision.type === "allow")
        return {
          type: "finished",
          request,
          authorization: {
            type: "allow",
            arguments: decision.assessment.normalizedArguments ?? request.arguments,
            assessment: decision.assessment,
            source: "ai",
          },
        }
      if (aiDecision.type === "deny" && request.mode !== "hybridConfirmDenials")
        return {
          type: "finished",
          request,
          authorization: {
            type: "deny",
            reason: aiDecision.reason,
            assessment: decision.assessment,
            source: "ai",
          },
        }
      return this.#humanOrDeny(request, decision, undefined, aiDecision)
    } catch (error) {
      const message = `AI 审核失败：${error instanceof Error ? error.message : String(error)}`
      await this.#record({ type: "aiReviewed", request, batchId, error: message, at: this.#timestamp() })
      return this.#humanOrDeny(request, decision, message)
    }
  }

  #humanOrDeny(
    request: ToolPermissionRequest,
    decision: ToolPermissionDecision | undefined,
    error?: string,
    aiDecision?: Extract<AiReviewDecision, { type: "deny" | "needHumanReview" }>,
  ): PreparedAuthorization {
    const assessment = decision?.assessment ?? {
      summary: request.toolName,
      targets: [],
      risk: "high" as const,
      reason: error ?? "需要用户判断",
      findings: [],
    }
    if (request.mode === "aiOnly")
      return {
        type: "finished",
        request,
        authorization: {
          type: "deny",
          reason: error ?? aiDecision?.reason ?? "当前权限模式不允许人工审核",
          ...(decision ? { assessment: decision.assessment } : {}),
          source: "system",
        },
      }
    return {
      type: "human",
      request,
      assessment,
      ...(decision ? { decision } : {}),
      ...(aiDecision ? { aiDecision } : {}),
      ...(error ? { error } : {}),
    }
  }

  async #reviewHumanBatch(
    batchId: string,
    items: Extract<PreparedAuthorization, { type: "human" }>[],
    signal?: AbortSignal,
  ): Promise<Map<string, HumanReviewResolution>> {
    const created = this.#now()
    const expiresAt = new Date(created.getTime() + this.#humanReviewTimeoutMs).toISOString()
    const requests: HumanReviewRequest[] = items.map((item) => {
      const sensitiveFields = this.#registry
        .get(item.request.toolName)
        ?.sensitiveFields?.filter((field): field is string => typeof field === "string")
      return {
        requestId: crypto.randomUUID(),
        batchId,
        sessionId: item.request.sessionId,
        turnId: item.request.turnId,
        toolCallId: item.request.toolCallId,
        toolName: item.request.toolName,
        declaredIntent: item.request.declaredIntent,
        cwd: item.request.cwd,
        arguments: item.request.arguments,
        assessment: item.assessment,
        ...(item.aiDecision ? { aiDecision: item.aiDecision } : {}),
        ...(item.error ? { aiError: item.error } : {}),
        ...(sensitiveFields && sensitiveFields.length > 0 ? { sensitiveFields } : {}),
        createdAt: created.toISOString(),
        expiresAt,
      }
    })
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error("人工审核超时")), this.#humanReviewTimeoutMs)
    try {
      const decision = await this.#humanReviewer.review(
        {
          batchId,
          sessionId: requests[0]?.sessionId ?? "",
          turnId: requests[0]?.turnId ?? "",
          requests,
          createdAt: created.toISOString(),
          expiresAt,
        },
        controller.signal,
      )
      if (decision.batchId !== batchId) throw new Error("人工审核批次不匹配")
      const answers = new Map(decision.answers.map((answer) => [answer.requestId, answer]))
      if (answers.size !== requests.length || requests.some((request) => !answers.has(request.requestId)))
        throw new Error("人工审核没有覆盖批次中的全部请求")
      const resolutions = new Map<string, HumanReviewResolution>()
      for (const request of requests) {
        const answer = answers.get(request.requestId)
        if (!answer) continue
        const source = items.find((item) => item.request.toolCallId === request.toolCallId)
        if (source) {
          resolutions.set(request.toolCallId, answer)
          await this.#record({
            type: "humanReviewed",
            request: source.request,
            batchId,
            decision: answer,
            at: this.#timestamp(),
          })
        }
      }
      return resolutions
    } catch (caught) {
      if (signal?.aborted) return new Map(requests.map((request) => [request.toolCallId, { type: "aborted" } as const]))
      const reason =
        caught instanceof Error && caught.message === "人工审核超时"
          ? "Operation denied: Permission review timed out after 10 minutes."
          : `Operation denied: Permission review failed. Reason: ${caught instanceof Error ? caught.message : String(caught)}`
      return new Map(requests.map((request) => [request.toolCallId, { type: "system", reason } as const]))
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
    }
  }

  #humanAuthorization(
    item: Extract<PreparedAuthorization, { type: "human" }>,
    answers: Map<string, HumanReviewResolution>,
  ): ToolAuthorization {
    const answer = answers.get(item.request.toolCallId)
    if (!answer)
      return { type: "deny", reason: "Operation denied: Permission review returned no result.", source: "system" }
    if (answer.type === "approve")
      return {
        type: "allow",
        arguments: item.decision?.assessment.normalizedArguments ?? item.request.arguments,
        assessment: item.assessment,
        source: "human",
      }
    if (answer.type === "deny")
      return {
        type: "deny",
        reason: answer.reason
          ? `Operation denied: User denied permission. Reason: ${answer.reason}`
          : "Operation denied: User denied permission without providing a reason.",
        assessment: item.assessment,
        source: "human",
      }
    if (answer.type === "aborted")
      return {
        type: "aborted",
        reason: "Operation aborted: User aborted the turn while permission review was pending.",
      }
    return { type: "deny", reason: answer.reason, assessment: item.assessment, source: "system" }
  }

  #timestamp(): string {
    return this.#now().toISOString()
  }

  async #record(event: PermissionAuditEvent): Promise<void> {
    await this.#audit(event)
  }
}
