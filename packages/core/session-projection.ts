import type { SessionRecord, WorkingDirectoryChangedRecord } from "./session-format.ts"

/** 生成用户和 Agent 共用的工作目录变化提示。 */
export function workingDirectoryChangeText(previousCwd: string, currentCwd: string): string {
  const quote = (path: string) => `"${path.replaceAll('"', '\\"')}"`
  return `Working directory changed from ${quote(previousCwd)} to ${quote(currentCwd)}.`
}

/**
 * 生成用户历史与 Agent 恢复上下文共同使用的会话记录投影。
 * 未完成轮次不可见；相邻且没有对话分隔的工作目录变化合并为一次变化。
 */
export function projectVisibleSessionRecords(records: SessionRecord[]): SessionRecord[] {
  const finishedTurns = new Set(
    records.filter((record) => record.kind === "turn_finished").map((record) => record.turnId),
  )
  const visible = records.filter(
    (record) => (record.kind !== "turn_started" && record.kind !== "message") || finishedTurns.has(record.turnId),
  )
  const projected: SessionRecord[] = []
  let pendingChangeIndex: number | undefined
  for (const record of visible) {
    if (record.kind === "turn_started") pendingChangeIndex = undefined
    if (record.kind !== "working_directory_changed") {
      projected.push(record)
      continue
    }
    const previous = pendingChangeIndex === undefined ? undefined : projected[pendingChangeIndex]
    if (pendingChangeIndex === undefined || previous?.kind !== "working_directory_changed") {
      pendingChangeIndex = projected.push(record) - 1
      continue
    }
    projected.splice(pendingChangeIndex, 1)
    const merged: WorkingDirectoryChangedRecord = {
      ...record,
      previousCwd: previous.previousCwd,
    }
    pendingChangeIndex = projected.push(merged) - 1
  }
  return projected
}
