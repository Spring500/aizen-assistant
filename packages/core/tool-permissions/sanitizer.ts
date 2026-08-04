import type { JsonValue } from "../session-format.ts"

const defaultSensitiveKey =
  /(token|password|passwd|secret|api[_-]?key|private[_-]?key|authorization|cookie|credential)/i
const hiddenPayloadKey =
  /(token|password|passwd|secret|api[_-]?key|private[_-]?key|authorization|cookie|credential|content|body|details|patch|oldText|newText|evidence)/i
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

function sanitize(value: JsonValue, key?: string, extra: SensitiveFieldMatcher[] = []): JsonValue {
  if (key && (hiddenPayloadKey.test(key) || matchesSensitiveKey(key, extra))) return "[敏感内容已隐藏]"
  if (typeof value === "string") return truncate(value)
  if (Array.isArray(value)) return value.map((item) => sanitize(item, undefined, extra))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [childKey, sanitize(item, childKey, extra)]),
    )
  return value
}

/** 为远程 AI 审核生成有界且经过字段级脱敏的负载。 */
export function sanitizeReviewPayload(value: JsonValue, extra: SensitiveFieldMatcher[] = []): JsonValue {
  const sanitized = sanitize(value, undefined, extra)
  const text = JSON.stringify(sanitized)
  if (Buffer.byteLength(text) <= maximumPayloadBytes) return sanitized
  return { truncated: true, preview: truncate(text.slice(0, maximumStringBytes)) }
}

function isToolAuthorization(value: JsonValue): value is { [key: string]: JsonValue } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return value.type === "allow" || value.type === "deny" || value.type === "aborted"
}

function sanitizeAudit(value: JsonValue, key?: string, extra: SensitiveFieldMatcher[] = []): JsonValue {
  if (key === "authorization" && isToolAuthorization(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [childKey, sanitizeAudit(item, childKey, extra)]),
    )
  }
  if (key && (hiddenPayloadKey.test(key) || matchesSensitiveKey(key, extra))) return "[敏感内容已隐藏]"
  if (typeof value === "string") return truncate(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeAudit(item, undefined, extra))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [childKey, sanitizeAudit(item, childKey, extra)]),
    )
  return value
}

/** 为本地权限记录生成脱敏、截断且保留结构化授权状态的副本。 */
export function sanitizePermissionAuditPayload(value: JsonValue, extra: SensitiveFieldMatcher[] = []): JsonValue {
  const sanitized = sanitizeAudit(value, undefined, extra)
  const serialized = JSON.stringify(sanitized)
  if (Buffer.byteLength(serialized) <= maximumPayloadBytes) return sanitized
  return { truncated: true, preview: truncate(serialized.slice(0, maximumStringBytes)) }
}

export type SensitiveFieldMatcher = RegExp | string

function matchesSensitiveKey(key: string, extra: SensitiveFieldMatcher[] = []): boolean {
  return (
    defaultSensitiveKey.test(key) ||
    extra.some((matcher) => {
      if (typeof matcher === "string") return matcher.toLowerCase() === key.toLowerCase()
      matcher.lastIndex = 0
      return matcher.test(key)
    })
  )
}

/** 返回对象中所有敏感字段的点分路径，供本地界面醒目标记而不隐藏原值。 */
export function sensitiveFieldPaths(value: JsonValue, extra: SensitiveFieldMatcher[] = []): string[] {
  const result: string[] = []
  const visit = (current: JsonValue, path: string) => {
    if (Array.isArray(current)) {
      for (const [index, item] of current.entries()) visit(item, path ? `${path}.${index}` : String(index))
      return
    }
    if (!current || typeof current !== "object") return
    for (const [key, child] of Object.entries(current)) {
      const childPath = path ? `${path}.${key}` : key
      if (matchesSensitiveKey(key, extra)) result.push(childPath)
      visit(child, childPath)
    }
  }
  visit(value, "")
  return result
}

/** 判断对象字段是否明确包含不应发送给审核模型的敏感内容。 */
export function containsSensitiveField(value: JsonValue, extra: SensitiveFieldMatcher[] = []): boolean {
  return sensitiveFieldPaths(value, extra).length > 0
}
