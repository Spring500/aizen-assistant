import type { ToolPermissionRegistry } from "./registry.ts"
import { sanitizePermissionAuditPayload, sanitizeReviewPayload } from "./sanitizer.ts"
import type {
  AiPermissionReviewer,
  AiReviewDecision,
  HumanPermissionReviewer,
  HumanReviewRequest,
  PermissionAuditEvent,
  PermissionCoverageGap,
  PermissionGapRecorder,
  PermissionReviewStep,
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
  gapRecorder?: PermissionGapRecorder
  reportGapRecordingError?: (error: Error) => void
  now?: () => Date
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
      reviewSteps: PermissionReviewStep[]
      aiDecision?: Extract<AiReviewDecision, { type: "deny" | "needHumanReview" }>
      error?: string
    }

function gapArguments(request: ToolPermissionRequest): ToolPermissionRequest["arguments"] {
  const input = request.arguments
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  if (request.toolName === "bash") return input
  if (request.toolName === "read")
    return {
      path: input.path ?? null,
      offset: input.offset ?? null,
      limit: input.limit ?? null,
    }
  if (request.toolName === "write") {
    const content = typeof input.content === "string" ? input.content : ""
    return {
      path: input.path ?? null,
      contentCharacters: content.length,
      contentLines: content ? content.split("\n").length : 0,
    }
  }
  if (request.toolName === "edit") {
    const edits = Array.isArray(input.edits) ? input.edits : []
    return {
      path: input.path ?? null,
      editCount: edits.length,
      replacements: edits.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return { oldCharacters: 0, newCharacters: 0 }
        return {
          oldCharacters: typeof item.oldText === "string" ? item.oldText.length : 0,
          newCharacters: typeof item.newText === "string" ? item.newText.length : 0,
        }
      }),
    }
  }
  return sanitizePermissionAuditPayload(input, request.sensitiveFields)
}

export class ToolPermissionManager {
  readonly #registry: ToolPermissionRegistry
  readonly #aiReviewer: AiPermissionReviewer
  readonly #humanReviewer: HumanPermissionReviewer
  readonly #audit: (event: PermissionAuditEvent) => void | Promise<void>
  readonly #gapRecorder: PermissionGapRecorder | undefined
  readonly #reportGapRecordingError: (error: Error) => void
  readonly #now: () => Date
  #gapRecordingFailed = false

  constructor(options: ToolPermissionManagerOptions) {
    this.#registry = options.registry
    this.#aiReviewer = options.aiReviewer
    this.#humanReviewer = options.humanReviewer
    this.#audit = options.audit ?? (() => {})
    this.#gapRecorder = options.gapRecorder
    this.#reportGapRecordingError = options.reportGapRecordingError ?? (() => {})
    this.#now = options.now ?? (() => new Date())
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
      if (this.#gapRecorder) await this.#inspectUnrestricted(request, signal)
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
    if (!validator) {
      await this.#recordGap(request, "missing", [
        {
          code: "validator.missing",
          kind: "rule-miss",
          summary: "该工具没有权限验证器",
        },
      ])
      return this.#humanOrDeny(request, undefined, "该工具没有权限验证器")
    }
    const sensitiveFields = validator.sensitiveFields?.filter((field): field is string => typeof field === "string")
    if (sensitiveFields && sensitiveFields.length > 0) request.sensitiveFields = sensitiveFields

    let decision: ToolPermissionDecision
    try {
      decision = await validator.validate(request, signal)
    } catch (error) {
      const message = `权限验证器异常：${error instanceof Error ? error.message : String(error)}`
      await this.#recordGap(request, "error", [
        {
          code: "validator.error",
          kind: "parse-failure",
          summary: message,
        },
      ])
      return this.#humanOrDeny(request, undefined, message)
    }
    await this.#recordGap(request, decision.type, decision.assessment.coverageGaps ?? [])
    await this.#record({ type: "validated", request, batchId, decision, at: this.#timestamp() })

    const validatorStep: PermissionReviewStep = {
      stage: "validator",
      decision: decision.type,
      reason: decision.type === "deny" ? decision.reason : decision.assessment.reason,
    }

    if (decision.type === "deny")
      return {
        type: "finished",
        request,
        authorization: {
          type: "deny",
          reason: decision.reason,
          assessment: decision.assessment,
          source: "validator",
          reviewSteps: [validatorStep],
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
    if (decision.type === "needHumanReview")
      return this.#humanOrDeny(request, decision, undefined, undefined, [validatorStep])

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
      const aiStep: PermissionReviewStep = {
        stage: "ai",
        decision: aiDecision.type,
        reason: aiDecision.reason,
      }
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
            reviewSteps: [validatorStep, aiStep],
          },
        }
      return this.#humanOrDeny(request, decision, undefined, aiDecision, [validatorStep, aiStep])
    } catch (error) {
      const message = `AI 审核失败：${error instanceof Error ? error.message : String(error)}`
      await this.#record({ type: "aiReviewed", request, batchId, error: message, at: this.#timestamp() })
      return this.#humanOrDeny(request, decision, message, undefined, [
        validatorStep,
        { stage: "ai", decision: "error", reason: message },
      ])
    }
  }

  #humanOrDeny(
    request: ToolPermissionRequest,
    decision: ToolPermissionDecision | undefined,
    error?: string,
    aiDecision?: Extract<AiReviewDecision, { type: "deny" | "needHumanReview" }>,
    reviewSteps: PermissionReviewStep[] = [],
  ): PreparedAuthorization {
    const effectiveReviewSteps =
      reviewSteps.length === 0 && error
        ? [{ stage: "validator" as const, decision: "error", reason: error }]
        : reviewSteps
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
          reviewSteps: effectiveReviewSteps,
        },
      }
    return {
      type: "human",
      request,
      assessment,
      reviewSteps: effectiveReviewSteps,
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
      }
    })
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const decision = await this.#humanReviewer.review(
        {
          batchId,
          sessionId: requests[0]?.sessionId ?? "",
          turnId: requests[0]?.turnId ?? "",
          requests,
          createdAt: created.toISOString(),
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
      const reason = `Operation denied: Permission review failed. Reason: ${caught instanceof Error ? caught.message : String(caught)}`
      return new Map(requests.map((request) => [request.toolCallId, { type: "system", reason } as const]))
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  }

  #humanAuthorization(
    item: Extract<PreparedAuthorization, { type: "human" }>,
    answers: Map<string, HumanReviewResolution>,
  ): ToolAuthorization {
    const answer = answers.get(item.request.toolCallId)
    if (!answer)
      return {
        type: "deny",
        reason: "Operation denied: Permission review returned no result.",
        source: "system",
        reviewSteps: [...item.reviewSteps, { stage: "system", decision: "deny", reason: "人工审核没有返回结果" }],
      }
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
        reviewSteps: [
          ...item.reviewSteps,
          {
            stage: "human",
            decision: "deny",
            reason: answer.reason ?? "用户拒绝且未提供理由",
          },
        ],
      }
    if (answer.type === "aborted")
      return {
        type: "aborted",
        reason: "Operation aborted: User aborted the turn while permission review was pending.",
        reviewSteps: [...item.reviewSteps, { stage: "human", decision: "aborted", reason: "用户中止了本轮" }],
      }
    return {
      type: "deny",
      reason: answer.reason,
      assessment: item.assessment,
      source: "system",
      reviewSteps: [...item.reviewSteps, { stage: "system", decision: "deny", reason: answer.reason }],
    }
  }

  async #inspectUnrestricted(request: ToolPermissionRequest, signal?: AbortSignal): Promise<void> {
    const validator = this.#registry.get(request.toolName)
    if (!validator) {
      await this.#recordGap(request, "missing", [
        {
          code: "validator.missing",
          kind: "rule-miss",
          summary: "该工具没有权限验证器",
        },
      ])
      return
    }
    try {
      const sensitiveFields = validator.sensitiveFields?.filter((field): field is string => typeof field === "string")
      if (sensitiveFields && sensitiveFields.length > 0) request.sensitiveFields = sensitiveFields
      const decision = await validator.validate(request, signal)
      await this.#recordGap(request, decision.type, decision.assessment.coverageGaps ?? [])
    } catch (error) {
      await this.#recordGap(request, "error", [
        {
          code: "validator.error",
          kind: "parse-failure",
          summary: `权限验证器异常：${error instanceof Error ? error.message : String(error)}`,
        },
      ])
    }
  }

  async #recordGap(
    request: ToolPermissionRequest,
    validatorDecision: ToolPermissionDecision["type"] | "missing" | "error",
    gaps: PermissionCoverageGap[],
  ): Promise<void> {
    if (!this.#gapRecorder || gaps.length === 0) return
    try {
      await this.#gapRecorder.record({
        version: 1,
        at: this.#timestamp(),
        sessionId: request.sessionId,
        turnId: request.turnId,
        toolCallId: request.toolCallId,
        permissionMode: request.mode,
        toolName: request.toolName,
        declaredIntent: request.declaredIntent,
        cwd: request.cwd,
        ...(request.environment === undefined ? {} : { environment: request.environment }),
        validatorDecision,
        gaps,
        arguments: gapArguments(request),
      })
    } catch (error) {
      if (this.#gapRecordingFailed) return
      this.#gapRecordingFailed = true
      this.#reportGapRecordingError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  #timestamp(): string {
    return this.#now().toISOString()
  }

  async #record(event: PermissionAuditEvent): Promise<void> {
    await this.#audit(event)
  }
}
