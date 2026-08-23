/**
 * 粗略估算 Mock 请求的 token 数：序列化协议体后按 Unicode 码点数估算。
 * 这不是 tokenizer 的精确结果，但能让中英文长上下文随请求规模增长，避免固定用量掩盖压缩行为。
 */
export function estimateMockTokens(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value)
  return serialized ? Math.max(1, Array.from(serialized).length) : 1
}
