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

export type ToolAuthorization =
  | { type: "allow"; arguments: JsonValue; assessment: ToolAssessment; source: "mode" | "validator" | "ai" | "human" }
  | { type: "deny"; reason: string; assessment?: ToolAssessment; source: "validator" | "ai" | "human" | "system" }
  | { type: "aborted"; reason: string }

export interface AiPermissionReviewer {
  review(request: AiReviewRequest, signal?: AbortSignal): Promise<AiReviewDecision>
}

export interface HumanPermissionReviewer {
  review(request: HumanReviewRequest, signal?: AbortSignal): Promise<HumanReviewDecision>
}

export type PermissionAuditEvent =
  | { type: "permissionRequested"; request: ToolPermissionRequest; at: string }
  | { type: "validated"; request: ToolPermissionRequest; decision: ToolPermissionDecision; at: string }
  | { type: "aiReviewed"; request: ToolPermissionRequest; decision?: AiReviewDecision; error?: string; at: string }
  | { type: "humanReviewed"; request: ToolPermissionRequest; decision: HumanReviewDecision; at: string }
  | { type: "authorized"; request: ToolPermissionRequest; authorization: ToolAuthorization; at: string }
