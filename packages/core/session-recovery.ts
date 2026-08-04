import type { JsonValue, SessionRecord } from "./session-format.ts"
import { appendPermissionReview, permissionFailureMessage } from "./tool-permissions/failure-message.ts"
import type { PermissionReviewStep, ToolAuthorization } from "./tool-permissions/types.ts"

type StoredObject = Record<string, JsonValue>

type ToolCallState = {
  turnId: string
  callId: string
  name: string
  reviewRequested: boolean
  reviewSteps: PermissionReviewStep[]
  authorization?: ToolAuthorization
  executionStarted?: StoredObject
  executionFinished?: StoredObject
  resultExists: boolean
  recoveryRecorded: boolean
}

function object(value: JsonValue | undefined): StoredObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function callKey(turnId: string, callId: string): string {
  return `${turnId}\0${callId}`
}

function authorization(value: JsonValue | undefined): ToolAuthorization | undefined {
  const source = object(value)
  if (!source || (source.type !== "allow" && source.type !== "deny" && source.type !== "aborted")) return undefined
  return source as unknown as ToolAuthorization
}

function isRecoveryEvent(type: string | undefined): boolean {
  return (
    type === "interruptedBeforeReview" ||
    type === "interruptedDuringReview" ||
    type === "interruptedBeforeStart" ||
    type === "interruptedAfterStart" ||
    type === "interruptedAfterFinish" ||
    type === "interruptedAuthorizationFailure"
  )
}

function recoveryResult(call: ToolCallState): {
  type: string
  message: string
  details: Record<string, JsonValue>
} {
  if (call.executionStarted && !call.executionFinished)
    return {
      type: "interruptedAfterStart",
      message:
        "Operation interrupted: Execution started, but its outcome is unknown. Verify the target state before retrying or making further changes.",
      details: { interrupted: true, stage: "execution", executionStarted: true },
    }
  if (call.executionFinished) {
    const error = text(call.executionFinished.error)
    const failed = call.executionFinished.isError === true
    return {
      type: "interruptedAfterFinish",
      message: failed
        ? `${error ?? "Operation failed: The tool failed before its result was saved."}\n\nVerify the target state before retrying because the operation may have had partial effects.`
        : "Operation interrupted: The tool completed, but its result was lost. Verify the target state before repeating the operation.",
      details: {
        interrupted: true,
        stage: "afterExecution",
        executionStarted: true,
        executionFinished: true,
      },
    }
  }
  if (!call.authorization) {
    const reviewed = call.reviewRequested
    const base = reviewed
      ? "Operation interrupted: Permission review did not complete, so the tool did not run. Submit a new tool call only if it is still needed."
      : "Operation interrupted: The application stopped before permission review started, so the tool did not run. Submit a new tool call only if it is still needed."
    return {
      type: reviewed ? "interruptedDuringReview" : "interruptedBeforeReview",
      message: appendPermissionReview(base, call.reviewSteps),
      details: { interrupted: true, stage: "permissionReview", executionStarted: false },
    }
  }
  if (call.authorization.type === "deny" || call.authorization.type === "aborted")
    return {
      type: "interruptedAuthorizationFailure",
      message: `${permissionFailureMessage(call.authorization)}\n\nThe tool did not run.`,
      details: { interrupted: true, stage: "authorization", executionStarted: false },
    }
  return {
    type: "interruptedBeforeStart",
    message:
      "Operation interrupted: The tool was authorized but did not start. Submit a new tool call if it is still needed.",
    details: { interrupted: true, stage: "beforeExecution", executionStarted: false },
  }
}

/**
 * 根据已落盘的工具生命周期记录补齐异常退出结果。
 * 每个调用独立恢复，且只为包含 Assistant 工具调用的未完成轮次生成 Agent 可见结果。
 */
export function recoverInterruptedToolCalls(records: SessionRecord[]): SessionRecord[] {
  const calls = new Map<string, ToolCallState>()
  const callsByTurn = new Map<string, ToolCallState[]>()
  const finishedTurns = new Set<string>()
  const ensureCall = (turnId: string, callId: string, name = "unknown") => {
    const key = callKey(turnId, callId)
    const existing = calls.get(key)
    if (existing) {
      if (existing.name === "unknown" && name !== "unknown") existing.name = name
      return existing
    }
    const created: ToolCallState = {
      turnId,
      callId,
      name,
      reviewRequested: false,
      reviewSteps: [],
      resultExists: false,
      recoveryRecorded: false,
    }
    calls.set(key, created)
    callsByTurn.set(turnId, [...(callsByTurn.get(turnId) ?? []), created])
    return created
  }
  const requestCall = (turnId: string, value: JsonValue | undefined) => {
    const request = object(value)
    const callId = text(request?.toolCallId)
    return callId ? ensureCall(turnId, callId, text(request?.toolName)) : undefined
  }

  for (const record of records) {
    if (record.kind === "turn_finished") finishedTurns.add(record.turnId)
    if (record.kind === "message" && record.message.role === "assistant") {
      for (const part of record.message.parts)
        if (part.kind === "tool_call") ensureCall(record.turnId, part.callId, part.name)
    }
    if (record.kind === "message" && record.message.role === "tool")
      ensureCall(record.turnId, record.message.callId, record.message.name).resultExists = true
    if (record.kind !== "tool_permission") continue
    const event = object(record.event)
    if (!event) continue
    const eventType = text(event.type)
    if (eventType === "permissionBatchRequested") {
      const batch = object(event.batch)
      if (Array.isArray(batch?.calls))
        for (const request of batch.calls) {
          const call = requestCall(record.turnId, request)
          if (call) call.reviewRequested = true
        }
    }
    const call = requestCall(record.turnId, event.request) ?? ensureCall(record.turnId, record.toolCallId)
    if (eventType === "permissionRequested") call.reviewRequested = true
    if (eventType === "validated") {
      call.reviewRequested = true
      const decision = object(event.decision)
      const assessment = object(decision?.assessment)
      const decisionType = text(decision?.type)
      if (decisionType)
        call.reviewSteps.push({
          stage: "validator",
          decision: decisionType,
          reason: text(decision?.reason) ?? text(assessment?.reason) ?? "验证器没有提供理由",
        })
    }
    if (eventType === "aiReviewed") {
      call.reviewRequested = true
      const decision = object(event.decision)
      const error = text(event.error)
      call.reviewSteps.push({
        stage: "ai",
        decision: error ? "error" : (text(decision?.type) ?? "unknown"),
        reason: error ?? text(decision?.reason) ?? "AI 审核没有提供理由",
      })
    }
    if (eventType === "humanReviewed") {
      call.reviewRequested = true
      const decision = object(event.decision)
      call.reviewSteps.push({
        stage: "human",
        decision: text(decision?.type) ?? "unknown",
        reason: text(decision?.reason) ?? "用户未提供理由",
      })
    }
    if (eventType === "authorized") {
      const storedAuthorization = authorization(event.authorization)
      if (storedAuthorization) call.authorization = storedAuthorization
    }
    if (event.phase === "executionStarted") {
      call.executionStarted = event
      const storedAuthorization = authorization(event.authorization)
      if (storedAuthorization) call.authorization = storedAuthorization
    }
    if (event.phase === "executionFinished") {
      call.executionFinished = event
      const storedAuthorization = authorization(event.authorization)
      if (storedAuthorization) call.authorization = storedAuthorization
    }
    if (isRecoveryEvent(eventType)) call.recoveryRecorded = true
  }

  const result: SessionRecord[] = []
  const now = new Date().toISOString()
  for (const [turnId, turnCalls] of callsByTurn) {
    if (finishedTurns.has(turnId)) continue
    let shouldFinishTurn = false
    for (const call of turnCalls) {
      if (call.resultExists) {
        shouldFinishTurn = true
        continue
      }
      const recovery = recoveryResult(call)
      if (!call.recoveryRecorded) {
        const assessment =
          call.authorization?.type === "allow"
            ? call.authorization.assessment
            : object(call.executionStarted?.authorization)?.assessment
        const assessmentObject = object(assessment as JsonValue | undefined)
        const recoveryChecks =
          recovery.type === "interruptedAfterStart" && Array.isArray(assessmentObject?.recoveryChecks)
            ? assessmentObject.recoveryChecks.filter((item): item is string => typeof item === "string")
            : []
        result.push({
          kind: "tool_permission",
          recordId: crypto.randomUUID(),
          turnId,
          at: now,
          toolCallId: call.callId,
          event: { type: recovery.type, message: recovery.message, recoveryChecks },
        })
      }
      result.push({
        kind: "message",
        recordId: crypto.randomUUID(),
        turnId,
        at: now,
        message: {
          role: "tool",
          callId: call.callId,
          name: call.name,
          parts: [{ kind: "text", text: recovery.message }],
          isError: true,
          details: recovery.details,
        },
      })
      shouldFinishTurn = true
    }
    if (shouldFinishTurn)
      result.push({
        kind: "turn_finished",
        recordId: crypto.randomUUID(),
        turnId,
        at: now,
        outcome: "failed",
        error: { code: "TOOL_CALL_INTERRUPTED", message: "应用在工具调用完成前异常终止" },
      })
  }
  return result
}
