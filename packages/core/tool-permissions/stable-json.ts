import type { JsonValue } from "../session-format.ts"

/** 生成与对象键插入顺序无关的 JSON 文本，用于审批绑定复核。 */
export function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`)
    .join(",")}}`
}
