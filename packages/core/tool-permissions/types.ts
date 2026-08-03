import type { JsonValue } from "../session-format.ts"

export const permissionModes = ["unrestricted", "hybrid", "hybridConfirmDenials", "aiOnly"] as const
export type PermissionMode = (typeof permissionModes)[number]

export type PermissionRisk = "low" | "medium" | "high" | "critical"

export type ToolAssessment = {
  summary: string
  targets: string[]
  risk: PermissionRisk
  reason: string
  details?: JsonValue
  match?: JsonValue
  normalizedArguments?: JsonValue
  recoveryChecks?: string[]
}

export type ToolPermissionDecision =
  | { type: "allow"; assessment: ToolAssessment }
  | { type: "deny"; reason: string; assessment: ToolAssessment }
  | { type: "needAiReview"; assessment: ToolAssessment; reviewPayload: JsonValue }
  | { type: "needHumanReview"; assessment: ToolAssessment }

export type ToolPermissionRequest = {
  sessionId: string
  turnId: string
  toolCallId: string
  toolName: string
  arguments: JsonValue
  declaredIntent: string
  cwd: string
  mode: PermissionMode
  environment?: JsonValue
}

export type ToolPermissionBatchRequest = {
  batchId: string
  calls: ToolPermissionRequest[]
}

export type ToolPermissionValidator = {
  toolName: string
  validate(request: ToolPermissionRequest, signal?: AbortSignal): Promise<ToolPermissionDecision>
}

export type AiReviewDecision =
  | { type: "allow"; reason: string }
  | { type: "deny"; reason: string }
  | { type: "needHumanReview"; reason: string; question?: string }

export type AiReviewRequest = {
  toolName: string
  declaredIntent: string
  cwd: string
  assessment: ToolAssessment
  payload: JsonValue
}

export type HumanReviewRequest = {
  requestId: string
  batchId: string
  sessionId: string
  turnId: string
  toolCallId: string
  toolName: string
  declaredIntent: string
  cwd: string
  arguments: JsonValue
  assessment: ToolAssessment
  aiDecision?: AiReviewDecision
  aiError?: string
  createdAt: string
  expiresAt: string
}

export type HumanReviewDecision = { type: "approve" } | { type: "deny"; reason?: string }

export type HumanReviewAnswer = HumanReviewDecision & { requestId: string }

export type HumanReviewBatchRequest = {
  batchId: string
  sessionId: string
  turnId: string
  requests: HumanReviewRequest[]
  createdAt: string
  expiresAt: string
}

export type HumanReviewBatchDecision = {
  batchId: string
  answers: HumanReviewAnswer[]
}

export type ToolAuthorization =
  | { type: "allow"; arguments: JsonValue; assessment: ToolAssessment; source: "mode" | "validator" | "ai" | "human" }
  | { type: "deny"; reason: string; assessment?: ToolAssessment; source: "validator" | "ai" | "human" | "system" }
  | { type: "aborted"; reason: string }

export type ToolPermissionBatchAuthorization = {
  batchId: string
  authorizations: Array<{ toolCallId: string; authorization: ToolAuthorization }>
}

export interface AiPermissionReviewer {
  review(request: AiReviewRequest, signal?: AbortSignal): Promise<AiReviewDecision>
}

export interface HumanPermissionReviewer {
  /** 一次展示并提交同一工具批次中所有需要人工判断的调用。 */
  review(request: HumanReviewBatchRequest, signal?: AbortSignal): Promise<HumanReviewBatchDecision>
}

export type PermissionAuditEvent =
  | { type: "permissionBatchRequested"; batch: ToolPermissionBatchRequest; at: string }
  | { type: "permissionRequested"; request: ToolPermissionRequest; batchId: string; at: string }
  | { type: "validated"; request: ToolPermissionRequest; batchId: string; decision: ToolPermissionDecision; at: string }
  | {
      type: "aiReviewed"
      request: ToolPermissionRequest
      batchId: string
      decision?: AiReviewDecision
      error?: string
      at: string
    }
  | {
      type: "humanReviewed"
      request: ToolPermissionRequest
      batchId: string
      decision: HumanReviewDecision
      at: string
    }
  | {
      type: "authorized"
      request: ToolPermissionRequest
      batchId: string
      authorization: ToolAuthorization
      at: string
    }
  | { type: "permissionBatchAuthorized"; batch: ToolPermissionBatchAuthorization; at: string }
