import type { JsonValue } from "../session-format.ts"
import type { PermissionPresetId, PermissionReviewMode } from "./policy-types.ts"
import type { SensitiveFieldMatcher } from "./sanitizer.ts"

export const permissionModes = ["unrestricted", "hybrid", "hybridConfirmDenials", "aiOnly"] as const
export type PermissionMode = (typeof permissionModes)[number]

export type PermissionRisk = "low" | "medium" | "high" | "critical"

export type PermissionFinding = {
  severity: "medium" | "high" | "critical"
  category: string
  summary: string
  evidence: string
}

export type PermissionCoverageGap = {
  code: string
  kind: "unsupported-environment" | "unsupported-syntax" | "parse-failure" | "rule-miss" | "coarse-rule"
  summary: string
  evidence?: string
}

export type ToolAssessment = {
  summary: string
  targets: string[]
  risk: PermissionRisk
  reason: string
  findings: PermissionFinding[]
  coverageGaps?: PermissionCoverageGap[]
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
  permissionPreset?: PermissionPresetId
  permissionReviewMode?: PermissionReviewMode
  environment?: JsonValue
  /** 第三方验证器声明的额外敏感字段，仅用于 AI 和本地记录脱敏。 */
  sensitiveFields?: string[]
}

export type ToolPermissionBatchRequest = {
  batchId: string
  calls: ToolPermissionRequest[]
}

export type ToolPermissionValidator = {
  toolName: string
  /** 声明该工具额外需要醒目标记和远程脱敏的敏感字段。 */
  sensitiveFields?: SensitiveFieldMatcher[]
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
  validatorDecision: "needAiReview"
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
  sensitiveFields?: string[]
  createdAt: string
}

export type HumanReviewDecision = { type: "approve" } | { type: "deny"; reason?: string }

export type HumanReviewAnswer = HumanReviewDecision & { requestId: string }

export type HumanReviewBatchRequest = {
  batchId: string
  sessionId: string
  turnId: string
  requests: HumanReviewRequest[]
  createdAt: string
}

export type HumanReviewBatchDecision = {
  batchId: string
  answers: HumanReviewAnswer[]
}

export type PermissionReviewStep = {
  stage: "validator" | "ai" | "human" | "system"
  decision: string
  reason: string
}

export type ToolAuthorization =
  | {
      type: "allow"
      arguments: JsonValue
      assessment: ToolAssessment
      source: "mode" | "validator" | "policy" | "reviewMode" | "ai" | "human"
      reviewSteps?: PermissionReviewStep[]
    }
  | {
      type: "deny"
      reason: string
      assessment?: ToolAssessment
      source: "validator" | "policy" | "ai" | "human" | "system"
      reviewSteps?: PermissionReviewStep[]
    }
  | { type: "aborted"; reason: string; reviewSteps?: PermissionReviewStep[] }

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

export type PermissionGapRecord = {
  version: 1
  at: string
  sessionId: string
  turnId: string
  toolCallId: string
  permissionMode: PermissionMode
  toolName: string
  declaredIntent: string
  cwd: string
  environment?: JsonValue
  validatorDecision: ToolPermissionDecision["type"] | "missing" | "error"
  gaps: PermissionCoverageGap[]
  arguments: JsonValue
}

export interface PermissionGapRecorder {
  /** 将一条规则缺口记录写入仅限本机的数据文件。 */
  record(record: PermissionGapRecord): Promise<void>
  /** 等待已排队记录写入完成并释放文件句柄。 */
  close?(): Promise<void>
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
