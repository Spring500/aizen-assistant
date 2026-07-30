import { sanitizeReviewPayload } from "./sanitizer.ts"
import type { ToolPermissionRegistry } from "./registry.ts"
import type {
  AiPermissionReviewer,
  AiReviewDecision,
  HumanPermissionReviewer,
  HumanReviewRequest,
  PermissionAuditEvent,
  ToolAuthorization,
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

  /** 对一条已通过工具 Schema 校验的调用执行完整权限流程。 */
  async authorize(request: ToolPermissionRequest, signal?: AbortSignal): Promise<ToolAuthorization> {
    await this.#record({ type: "permissionRequested", request, at: this.#timestamp() })
    if (signal?.aborted) return this.#finish(request, { type: "aborted", reason: "工具调用已中止" })
    if (request.mode === "unrestricted") {
      return this.#finish(request, {
        type: "allow",
        arguments: request.arguments,
        assessment: { summary: "完全开放模式", targets: [], risk: "low", reason: "当前会话允许直接执行工具" },
        source: "mode",
      })
    }

    const validator = this.#registry.get(request.toolName)
    if (!validator) return this.#humanOrDeny(request, undefined, "该工具没有权限验证器", signal)

    let decision: ToolPermissionDecision
    try {
      decision = await validator.validate(request, signal)
    } catch (error) {
      return this.#humanOrDeny(
        request,
        undefined,
        `权限验证器异常：${error instanceof Error ? error.message : String(error)}`,
        signal,
      )
    }
    await this.#record({ type: "validated", request, decision, at: this.#timestamp() })

    if (decision.type === "deny")
      return this.#finish(request, {
        type: "deny",
        reason: decision.reason,
        assessment: decision.assessment,
        source: "validator",
      })
    if (decision.type === "allow")
      return this.#finish(request, {
        type: "allow",
        arguments: decision.assessment.normalizedArguments ?? request.arguments,
        assessment: decision.assessment,
        source: "validator",
      })
    if (decision.type === "needHumanReview") return this.#humanOrDeny(request, decision, undefined, signal)

    try {
      const aiDecision = await this.#aiReviewer.review(
        {
          toolName: request.toolName,
          declaredIntent: request.declaredIntent,
          cwd: request.cwd,
          assessment: decision.assessment,
          payload: sanitizeReviewPayload(decision.reviewPayload),
        },
        signal,
      )
      await this.#record({ type: "aiReviewed", request, decision: aiDecision, at: this.#timestamp() })
      if (aiDecision.type === "allow")
        return this.#finish(request, {
          type: "allow",
          arguments: decision.assessment.normalizedArguments ?? request.arguments,
          assessment: decision.assessment,
          source: "ai",
        })
      if (aiDecision.type === "deny" && request.mode !== "hybridConfirmDenials")
        return this.#finish(request, {
          type: "deny",
          reason: aiDecision.reason,
          assessment: decision.assessment,
          source: "ai",
        })
      return this.#humanOrDeny(request, decision, undefined, signal, aiDecision)
    } catch (error) {
      const message = `AI 审核失败：${error instanceof Error ? error.message : String(error)}`
      await this.#record({ type: "aiReviewed", request, error: message, at: this.#timestamp() })
      return this.#humanOrDeny(request, decision, message, signal)
    }
  }

  async #humanOrDeny(
    request: ToolPermissionRequest,
    decision: ToolPermissionDecision | undefined,
    error: string | undefined,
    signal?: AbortSignal,
    aiDecision?: Extract<AiReviewDecision, { type: "deny" | "needHumanReview" }>,
  ): Promise<ToolAuthorization> {
    if (request.mode === "aiOnly")
      return this.#finish(request, {
        type: "deny",
        reason: error ?? aiDecision?.reason ?? "当前权限模式不允许人工审核",
        ...(decision ? { assessment: decision.assessment } : {}),
        source: "system",
      })

    const created = this.#now()
    const assessment = decision?.assessment ?? {
      summary: request.toolName,
      targets: [],
      risk: "high" as const,
      reason: error ?? "需要用户判断",
    }
    const reviewRequest: HumanReviewRequest = {
      requestId: crypto.randomUUID(),
      sessionId: request.sessionId,
      turnId: request.turnId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      declaredIntent: request.declaredIntent,
      cwd: request.cwd,
      arguments: request.arguments,
      assessment,
      ...(aiDecision ? { aiDecision } : {}),
      ...(error ? { aiError: error } : {}),
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + this.#humanReviewTimeoutMs).toISOString(),
    }
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error("人工审核超时")), this.#humanReviewTimeoutMs)
    try {
      const humanDecision = await this.#humanReviewer.review(reviewRequest, controller.signal)
      await this.#record({ type: "humanReviewed", request, decision: humanDecision, at: this.#timestamp() })
      if (humanDecision.type === "approve")
        return this.#finish(request, {
          type: "allow",
          arguments: decision?.assessment.normalizedArguments ?? request.arguments,
          assessment,
          source: "human",
        })
      return this.#finish(request, {
        type: "deny",
        reason: humanDecision.reason ?? "用户拒绝了工具调用",
        assessment,
        source: "human",
      })
    } catch (caught) {
      if (signal?.aborted) return this.#finish(request, { type: "aborted", reason: "工具调用已中止" })
      return this.#finish(request, {
        type: "deny",
        reason: caught instanceof Error ? caught.message : String(caught),
        assessment,
        source: "system",
      })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
    }
  }

  async #finish(request: ToolPermissionRequest, authorization: ToolAuthorization): Promise<ToolAuthorization> {
    await this.#record({ type: "authorized", request, authorization, at: this.#timestamp() })
    return authorization
  }

  #timestamp(): string {
    return this.#now().toISOString()
  }

  async #record(event: PermissionAuditEvent): Promise<void> {
    await this.#audit(event)
  }
}
