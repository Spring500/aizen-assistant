/**
 * 粗略估算 Mock 请求的 token 数：序列化协议体后按 Unicode 码点数除以 4。
 * 该口径与 pi 的压缩估算一致，使 Mock 上报用量、压缩阈值与保留预算处于同一尺度。
 */
export function estimateMockTokens(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value)
  return serialized ? Math.max(1, Math.ceil(Array.from(serialized).length / 4)) : 1
}
