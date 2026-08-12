import { Buffer } from "node:buffer"
import type { PermissionPresetId, PermissionReviewMode } from "./tool-permissions/policy-types.ts"

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type ViewId = string | null

export type ModelReference = {
  providerId: string
  modelId: string
  /** 当前选择的思考档位名；可选，表示未选择或模型不配置档位。 */
  thinkingLevel?: string
}

export type Timing = {
  startedAt: number
  finishedAt: number
}

export type TextPart = { kind: "text"; text: string; timing?: Timing }
export type ImagePart = { kind: "image"; mimeType: string; data: string }
export type ThinkingPart = { kind: "thinking"; text: string; signature?: string; timing?: Timing }
export type ToolCallPart = {
  kind: "tool_call"
  callId: string
  name: string
  arguments: JsonValue
  /** 模型声明的调用目的，仅表达模型意图，不代表工具的实际行为。 */
  declaredIntent?: string
  signature?: string
}

export type TurnInputItem = {
  source: string
  role: "user" | "system" | "developer"
  useLater: boolean
  parts: Array<TextPart | ImagePart>
}

export type SessionHeader = {
  kind: "session"
  version: 1
  sessionId: string
  cwd: string
  createdAt: string
}

export type SessionRenamedRecord = {
  kind: "session_renamed"
  recordId: string
  at: string
  name: string
}

export type ModelChangedRecord = {
  kind: "model_changed"
  recordId: string
  at: string
  model: ModelReference
}

export type ViewChangedRecord = {
  kind: "view_changed"
  recordId: string
  at: string
  viewId: ViewId
}

export type PermissionSettingsChangedRecord = {
  kind: "permission_settings_changed"
  recordId: string
  at: string
  preset: PermissionPresetId
  reviewMode: PermissionReviewMode
}

export type WorkingDirectoryChangedRecord = {
  kind: "working_directory_changed"
  recordId: string
  at: string
  previousCwd: string
  currentCwd: string
}

export type ToolPermissionRecord = {
  kind: "tool_permission"
  recordId: string
  turnId: string
  at: string
  toolCallId: string
  event: JsonValue
}

export type TurnStartedRecord = {
  kind: "turn_started"
  recordId: string
  turnId: string
  at: string
  viewId: ViewId
  items: TurnInputItem[]
}

export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
}

export type AssistantMessage = {
  role: "assistant"
  parts: Array<TextPart | ThinkingPart | ToolCallPart>
  source: {
    providerId: string
    modelId: string
    api: string
    responseId?: string
    responseModel?: string
  }
  stopReason: string
  errorMessage?: string
  usage: Usage
}

export type ToolMessage = {
  role: "tool"
  callId: string
  name: string
  parts: Array<TextPart | ImagePart>
  isError: boolean
  timing?: Timing
  details?: JsonValue
}

export type MessageRecord = {
  kind: "message"
  recordId: string
  turnId: string
  at: string
  message: AssistantMessage | ToolMessage
}

export type TurnFinishedRecord = {
  kind: "turn_finished"
  recordId: string
  turnId: string
  at: string
  outcome: "completed" | "aborted" | "failed"
  error?: { code: string; message: string }
}

export type CompactionRecord = {
  kind: "compaction"
  recordId: string
  at: string
  summary: string
  firstKeptRecordId: string
  tokensBefore: number
}

export type SessionRecord =
  | SessionRenamedRecord
  | ModelChangedRecord
  | ViewChangedRecord
  | WorkingDirectoryChangedRecord
  | PermissionSettingsChangedRecord
  | ToolPermissionRecord
  | TurnStartedRecord
  | MessageRecord
  | TurnFinishedRecord
  | CompactionRecord

export type SessionLine = SessionHeader | SessionRecord

/** 当前程序不认识的会话记录类型；调用方可以将其与内容损坏区分处理。 */
export class UnknownSessionRecordTypeError extends Error {
  constructor(recordKind: string) {
    super(`未知的会话记录类型：${recordKind}`)
  }
}

type UnknownObject = Record<string, unknown>

function object(value: unknown, label: string): UnknownObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as UnknownObject
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`)
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`)
  return value
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} 必须是有限数字`)
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label)
}

function base64(value: unknown, label: string): string {
  const result = string(value, label)
  if (!result || Buffer.from(result, "base64").toString("base64") !== result) throw new Error(`${label} 必须是 Base64`)
  return result
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return finiteNumber(value, label)
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`))
  const source = object(value, label)
  const result: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(source)) result[key] = jsonValue(item, `${label}.${key}`)
  return result
}

function viewId(value: unknown): ViewId {
  if (value === null) return null
  return string(value, "viewId")
}

function permissionPreset(value: unknown): PermissionPresetId {
  if (value !== "plan" && value !== "edit" && value !== "all-right" && value !== "custom")
    throw new Error(`未知的权限预设：${String(value)}`)
  return value
}

function permissionReviewMode(value: unknown): PermissionReviewMode {
  if (
    value !== "manual" &&
    value !== "aiReview" &&
    value !== "aiReviewWithAbstain" &&
    value !== "autoApprove" &&
    value !== "autoDeny"
  )
    throw new Error(`未知的审核方式：${String(value)}`)
  return value
}

/**
 * 解析模型引用。未知字段（含历史数据的 api 字段）一律忽略——
 * api 属于模型定义层，需要时从模型配置管理器查询。
 */
export function parseModelReference(value: unknown, label = "model"): ModelReference {
  const source = object(value, label)
  const thinkingLevel = optionalString(source.thinkingLevel, `${label}.thinkingLevel`)
  if (thinkingLevel === "") throw new Error(`${label}.thinkingLevel 必须是非空字符串`)
  return {
    providerId: string(source.providerId, `${label}.providerId`),
    modelId: string(source.modelId, `${label}.modelId`),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  }
}

function timing(value: unknown, label: string): Timing {
  const source = object(value, label)
  const startedAt = finiteNumber(source.startedAt, `${label}.startedAt`)
  const finishedAt = finiteNumber(source.finishedAt, `${label}.finishedAt`)
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(finishedAt))
    throw new Error(`${label} 必须使用安全整数毫秒时间戳`)
  if (finishedAt < startedAt) throw new Error(`${label}.finishedAt 不能早于 startedAt`)
  return { startedAt, finishedAt }
}

function optionalTiming(value: unknown, label: string): Timing | undefined {
  return value === undefined ? undefined : timing(value, label)
}

function inputPart(value: unknown): TextPart | ImagePart {
  const source = object(value, "输入内容块")
  const kind = string(source.kind, "输入内容块.kind")
  if (kind === "text") {
    const partTiming = optionalTiming(source.timing, "文字内容块.timing")
    return { kind, text: string(source.text, "文字内容块.text"), ...(partTiming ? { timing: partTiming } : {}) }
  }
  if (kind === "image") {
    return {
      kind,
      mimeType: string(source.mimeType, "图片内容块.mimeType"),
      data: base64(source.data, "图片内容块.data"),
    }
  }
  throw new Error(`未知的输入内容块：${kind}`)
}

function assistantPart(value: unknown): TextPart | ThinkingPart | ToolCallPart {
  const source = object(value, "助手内容块")
  const kind = string(source.kind, "助手内容块.kind")
  if (kind === "text") return inputPart(source) as TextPart
  if (kind === "thinking") {
    const signature = optionalString(source.signature, "思考内容块.signature")
    const partTiming = optionalTiming(source.timing, "思考内容块.timing")
    return {
      kind,
      text: string(source.text, "思考内容块.text"),
      ...(signature === undefined ? {} : { signature }),
      ...(partTiming ? { timing: partTiming } : {}),
    }
  }
  if (kind === "tool_call") {
    const signature = optionalString(source.signature, "工具调用内容块.signature")
    const declaredIntent = optionalString(source.declaredIntent, "工具调用内容块.declaredIntent")
    if (declaredIntent !== undefined && (declaredIntent.length === 0 || Array.from(declaredIntent).length > 50))
      throw new Error("工具调用内容块.declaredIntent 必须为 1 至 50 个字符")
    return {
      kind,
      callId: string(source.callId, "工具调用内容块.callId"),
      name: string(source.name, "工具调用内容块.name"),
      arguments: jsonValue(source.arguments, "工具调用内容块.arguments"),
      ...(declaredIntent === undefined ? {} : { declaredIntent }),
      ...(signature === undefined ? {} : { signature }),
    }
  }
  throw new Error(`未知的助手内容块：${kind}`)
}

function turnInputItem(value: unknown): TurnInputItem {
  const source = object(value, "轮次输入")
  const role = string(source.role, "轮次输入.role")
  if (role !== "user" && role !== "system" && role !== "developer") throw new Error(`未知的输入角色：${role}`)
  if (!Array.isArray(source.parts)) throw new Error("轮次输入.parts 必须是数组")
  return {
    source: string(source.source, "轮次输入.source"),
    role,
    useLater: boolean(source.useLater, "轮次输入.useLater"),
    parts: source.parts.map(inputPart),
  }
}

function usage(value: unknown): Usage {
  const source = object(value, "usage")
  const reasoning = source.reasoning === undefined ? undefined : finiteNumber(source.reasoning, "usage.reasoning")
  return {
    input: finiteNumber(source.input, "usage.input"),
    output: finiteNumber(source.output, "usage.output"),
    cacheRead: finiteNumber(source.cacheRead, "usage.cacheRead"),
    cacheWrite: finiteNumber(source.cacheWrite, "usage.cacheWrite"),
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

function message(value: unknown): AssistantMessage | ToolMessage {
  const source = object(value, "message")
  const role = string(source.role, "message.role")
  if (!Array.isArray(source.parts)) throw new Error("message.parts 必须是数组")
  if (role === "assistant") {
    const origin = object(source.source, "message.source")
    const responseId = optionalString(origin.responseId, "message.source.responseId")
    const responseModel = optionalString(origin.responseModel, "message.source.responseModel")
    return {
      role,
      parts: source.parts.map(assistantPart),
      source: {
        providerId: string(origin.providerId, "message.source.providerId"),
        modelId: string(origin.modelId, "message.source.modelId"),
        api: string(origin.api, "message.source.api"),
        ...(responseId === undefined ? {} : { responseId }),
        ...(responseModel === undefined ? {} : { responseModel }),
      },
      stopReason: string(source.stopReason, "message.stopReason"),
      ...(source.errorMessage === undefined
        ? {}
        : { errorMessage: string(source.errorMessage, "message.errorMessage") }),
      usage: usage(source.usage),
    }
  }
  if (role === "tool") {
    const messageTiming = optionalTiming(source.timing, "工具消息.timing")
    return {
      role,
      callId: string(source.callId, "message.callId"),
      name: string(source.name, "message.name"),
      parts: source.parts.map(inputPart),
      isError: boolean(source.isError, "message.isError"),
      ...(messageTiming ? { timing: messageTiming } : {}),
      ...(source.details === undefined ? {} : { details: jsonValue(source.details, "message.details") }),
    }
  }
  throw new Error(`未知的消息角色：${role}`)
}

function baseRecord(source: UnknownObject): { recordId: string; at: string } {
  return { recordId: string(source.recordId, "recordId"), at: string(source.at, "at") }
}

export function parseSessionValue(value: unknown): SessionLine {
  const source = object(value, "会话行")
  const kind = string(source.kind, "kind")
  if (kind === "session") {
    const version = finiteNumber(source.version, "version")
    if (version !== 1) throw new Error(`不支持的会话版本：${version}`)
    return {
      kind,
      version,
      sessionId: string(source.sessionId, "sessionId"),
      cwd: string(source.cwd, "cwd"),
      createdAt: string(source.createdAt, "createdAt"),
    }
  }
  if (kind === "session_renamed") {
    return {
      kind,
      ...baseRecord(source),
      name: string(source.name, "name"),
    }
  }
  if (kind === "model_changed") {
    return {
      kind,
      ...baseRecord(source),
      model: parseModelReference(source.model),
    }
  }
  if (kind === "view_changed") {
    return {
      kind,
      ...baseRecord(source),
      viewId: viewId(source.viewId),
    }
  }
  if (kind === "working_directory_changed") {
    return {
      kind,
      ...baseRecord(source),
      previousCwd: string(source.previousCwd, "previousCwd"),
      currentCwd: string(source.currentCwd, "currentCwd"),
    }
  }
  if (kind === "permission_settings_changed") {
    return {
      kind,
      ...baseRecord(source),
      preset: permissionPreset(source.preset),
      reviewMode: permissionReviewMode(source.reviewMode),
    }
  }
  if (kind === "tool_permission") {
    return {
      kind,
      ...baseRecord(source),
      turnId: string(source.turnId, "turnId"),
      toolCallId: string(source.toolCallId, "toolCallId"),
      event: jsonValue(source.event, "event"),
    }
  }
  if (kind === "turn_started") {
    const base = baseRecord(source)
    if (!Array.isArray(source.items)) throw new Error("items 必须是数组")
    return {
      kind,
      ...base,
      turnId: string(source.turnId, "turnId"),
      viewId: viewId(source.viewId),
      items: source.items.map(turnInputItem),
    }
  }
  if (kind === "message") {
    return {
      kind,
      ...baseRecord(source),
      turnId: string(source.turnId, "turnId"),
      message: message(source.message),
    }
  }
  if (kind === "turn_finished") {
    const outcome = string(source.outcome, "outcome")
    if (outcome !== "completed" && outcome !== "aborted" && outcome !== "failed") {
      throw new Error(`未知的轮次结果：${outcome}`)
    }
    const errorSource = source.error === undefined ? undefined : object(source.error, "error")
    return {
      kind,
      ...baseRecord(source),
      turnId: string(source.turnId, "turnId"),
      outcome,
      ...(errorSource
        ? {
            error: {
              code: string(errorSource.code, "error.code"),
              message: string(errorSource.message, "error.message"),
            },
          }
        : {}),
    }
  }
  if (kind === "compaction") {
    return {
      kind,
      ...baseRecord(source),
      summary: string(source.summary, "summary"),
      firstKeptRecordId: string(source.firstKeptRecordId, "firstKeptRecordId"),
      tokensBefore: finiteNumber(source.tokensBefore, "tokensBefore"),
    }
  }
  throw new UnknownSessionRecordTypeError(kind)
}

export function parseSessionLine(line: string): SessionLine {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    throw new Error(`会话行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  return parseSessionValue(value)
}
