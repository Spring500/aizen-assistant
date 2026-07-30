import type { JsonValue } from "../session-format.ts"

const sensitiveKey = /(token|password|passwd|secret|api[_-]?key|private[_-]?key|authorization|cookie|credential)/i
const hiddenPayloadKey =
  /(token|password|passwd|secret|api[_-]?key|private[_-]?key|authorization|cookie|credential|content|body)/i
const maximumStringBytes = 4096
const maximumPayloadBytes = 16384

function truncate(value: string): string {
  const bytes = Buffer.byteLength(value)
  if (bytes <= maximumStringBytes) return value
  let result = value
  while (Buffer.byteLength(`${result}…[已截断]`) > maximumStringBytes)
    result = result.slice(0, Math.max(0, result.length - 256))
  return `${result}…[已截断]`
}

function sanitize(value: JsonValue, key?: string): JsonValue {
  if (key && hiddenPayloadKey.test(key)) return "[敏感内容已隐藏]"
  if (typeof value === "string") return truncate(value)
  if (Array.isArray(value)) return value.map((item) => sanitize(item))
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, sanitize(item, childKey)]))
  return value
}

/** 为远程 AI 审核生成有界且经过字段级脱敏的负载。 */
export function sanitizeReviewPayload(value: JsonValue): JsonValue {
  const sanitized = sanitize(value)
  const text = JSON.stringify(sanitized)
  if (Buffer.byteLength(text) <= maximumPayloadBytes) return sanitized
  return { truncated: true, preview: truncate(text.slice(0, maximumStringBytes)) }
}

/** 判断对象字段是否明确包含不应发送给审核模型的敏感内容。 */
export function containsSensitiveField(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveField)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, child]) => sensitiveKey.test(key) || containsSensitiveField(child))
}
