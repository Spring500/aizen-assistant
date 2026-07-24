export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type ViewId = string | null

export type ModelReference = {
  providerId: string
  modelId: string
  api: string
  thinkingLevel: string
}

export type TextPart = { kind: "text"; text: string }
export type ImagePart = { kind: "image"; mimeType: string; fileHash: string }
export type ThinkingPart = { kind: "thinking"; text: string; signature?: string }
export type ToolCallPart = {
  kind: "tool_call"
  callId: string
  name: string
  arguments: JsonValue
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
  | ModelChangedRecord
  | ViewChangedRecord
  | TurnStartedRecord
  | MessageRecord
  | TurnFinishedRecord
  | CompactionRecord

export type SessionLine = SessionHeader | SessionRecord

type UnknownObject = Record<string, unknown>

function object(value: unknown, label: string): UnknownObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as UnknownObject
}

function exact(value: UnknownObject, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} 包含未知字段：${key}`)
  }
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

function modelReference(value: unknown): ModelReference {
  const source = object(value, "model")
  exact(source, ["providerId", "modelId", "api", "thinkingLevel"], "model")
  return {
    providerId: string(source.providerId, "model.providerId"),
    modelId: string(source.modelId, "model.modelId"),
    api: string(source.api, "model.api"),
    thinkingLevel: string(source.thinkingLevel, "model.thinkingLevel"),
  }
}

function inputPart(value: unknown): TextPart | ImagePart {
  const source = object(value, "输入内容块")
  const kind = string(source.kind, "输入内容块.kind")
  if (kind === "text") {
    exact(source, ["kind", "text"], "文字内容块")
    return { kind, text: string(source.text, "文字内容块.text") }
  }
  if (kind === "image") {
    exact(source, ["kind", "mimeType", "fileHash"], "图片内容块")
    return {
      kind,
      mimeType: string(source.mimeType, "图片内容块.mimeType"),
      fileHash: string(source.fileHash, "图片内容块.fileHash"),
    }
  }
  throw new Error(`未知的输入内容块：${kind}`)
}

function assistantPart(value: unknown): TextPart | ThinkingPart | ToolCallPart {
  const source = object(value, "助手内容块")
  const kind = string(source.kind, "助手内容块.kind")
  if (kind === "text") return inputPart(source) as TextPart
  if (kind === "thinking") {
    exact(source, ["kind", "text", "signature"], "思考内容块")
    const signature = optionalString(source.signature, "思考内容块.signature")
    return { kind, text: string(source.text, "思考内容块.text"), ...(signature === undefined ? {} : { signature }) }
  }
  if (kind === "tool_call") {
    exact(source, ["kind", "callId", "name", "arguments", "signature"], "工具调用内容块")
    const signature = optionalString(source.signature, "工具调用内容块.signature")
    return {
      kind,
      callId: string(source.callId, "工具调用内容块.callId"),
      name: string(source.name, "工具调用内容块.name"),
      arguments: jsonValue(source.arguments, "工具调用内容块.arguments"),
      ...(signature === undefined ? {} : { signature }),
    }
  }
  throw new Error(`未知的助手内容块：${kind}`)
}

function turnInputItem(value: unknown): TurnInputItem {
  const source = object(value, "轮次输入")
  exact(source, ["source", "role", "useLater", "parts"], "轮次输入")
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
  exact(source, ["input", "output", "cacheRead", "cacheWrite", "reasoning"], "usage")
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
    exact(source, ["role", "parts", "source", "stopReason", "errorMessage", "usage"], "助手消息")
    const origin = object(source.source, "message.source")
    exact(origin, ["providerId", "modelId", "api", "responseId", "responseModel"], "message.source")
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
    exact(source, ["role", "callId", "name", "parts", "isError", "details"], "工具消息")
    return {
      role,
      callId: string(source.callId, "message.callId"),
      name: string(source.name, "message.name"),
      parts: source.parts.map(inputPart),
      isError: boolean(source.isError, "message.isError"),
      ...(source.details === undefined ? {} : { details: jsonValue(source.details, "message.details") }),
    }
  }
  throw new Error(`未知的消息角色：${role}`)
}

function baseRecord(source: UnknownObject, allowed: readonly string[]): { recordId: string; at: string } {
  exact(source, allowed, "会话记录")
  return { recordId: string(source.recordId, "recordId"), at: string(source.at, "at") }
}

export function parseSessionValue(value: unknown): SessionLine {
  const source = object(value, "会话行")
  const kind = string(source.kind, "kind")
  if (kind === "session") {
    exact(source, ["kind", "version", "sessionId", "cwd", "createdAt"], "会话文件头")
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
  if (kind === "model_changed") {
    return {
      kind,
      ...baseRecord(source, ["kind", "recordId", "at", "model"]),
      model: modelReference(source.model),
    }
  }
  if (kind === "view_changed") {
    return {
      kind,
      ...baseRecord(source, ["kind", "recordId", "at", "viewId"]),
      viewId: viewId(source.viewId),
    }
  }
  if (kind === "turn_started") {
    const base = baseRecord(source, ["kind", "recordId", "turnId", "at", "viewId", "items"])
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
      ...baseRecord(source, ["kind", "recordId", "turnId", "at", "message"]),
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
    if (errorSource) exact(errorSource, ["code", "message"], "error")
    return {
      kind,
      ...baseRecord(source, ["kind", "recordId", "turnId", "at", "outcome", "error"]),
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
      ...baseRecord(source, ["kind", "recordId", "at", "summary", "firstKeptRecordId", "tokensBefore"]),
      summary: string(source.summary, "summary"),
      firstKeptRecordId: string(source.firstKeptRecordId, "firstKeptRecordId"),
      tokensBefore: finiteNumber(source.tokensBefore, "tokensBefore"),
    }
  }
  throw new Error(`未知的会话记录类型：${kind}`)
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
