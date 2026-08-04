import type { SessionRecord } from "./session-format.ts"

/**
 * 生成用户历史与 Agent 恢复上下文共同使用的会话记录投影。
 * 未完成轮次在恢复器补齐前对两端都不可见，避免界面与模型上下文出现分歧。
 */
export function projectVisibleSessionRecords(records: SessionRecord[]): SessionRecord[] {
  const finishedTurns = new Set(
    records.filter((record) => record.kind === "turn_finished").map((record) => record.turnId),
  )
  return records.filter(
    (record) => (record.kind !== "turn_started" && record.kind !== "message") || finishedTurns.has(record.turnId),
  )
}
