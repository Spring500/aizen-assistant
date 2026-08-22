import type { CompactionRecord, SessionRecord, WorkingDirectoryChangedRecord } from "./session-format.ts"

/** 生成用户和 Agent 共用的工作目录变化提示。 */
export function workingDirectoryChangeText(previousCwd: string, currentCwd: string): string {
  const quote = (path: string) => `"${path.replaceAll('"', '\\"')}"`
  return `Working directory changed from ${quote(previousCwd)} to ${quote(currentCwd)}.`
}

/**
 * 生成用户历史与 Agent 恢复上下文共同使用的会话记录投影。
 * 未完成轮次不可见；相邻且没有对话分隔的工作目录变化合并为一次变化。
 */
export function projectVisibleSessionRecords(records: SessionRecord[], activeTurnId?: string): SessionRecord[] {
  const finishedTurns = new Set(
    records.filter((record) => record.kind === "turn_finished").map((record) => record.turnId),
  )
  const visible = records.filter(
    (record) =>
      (record.kind !== "turn_started" && record.kind !== "message") ||
      finishedTurns.has(record.turnId) ||
      record.turnId === activeTurnId,
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

function latestCompaction(records: SessionRecord[]): { record: CompactionRecord; index: number } | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record?.kind === "compaction") return { record, index }
  }
  return undefined
}

/**
 * 生成主对话投影：没有压缩时展示完整可见历史；有压缩时仅展示当前摘要、
 * 从 firstKeptRecordId 到压缩点的保留记录，以及压缩后新增的记录。
 */
export function projectCurrentTranscriptRecords(records: SessionRecord[], activeTurnId?: string): SessionRecord[] {
  const active = latestCompaction(records)
  if (!active) return projectVisibleSessionRecords(records, activeTurnId)
  const firstKeptIndex = records.findIndex((record) => record.recordId === active.record.firstKeptRecordId)
  if (firstKeptIndex < 0 || firstKeptIndex >= active.index) return projectVisibleSessionRecords(records, activeTurnId)
  const current = [active.record, ...records.slice(firstKeptIndex, active.index), ...records.slice(active.index + 1)]
  return projectVisibleSessionRecords(current, activeTurnId)
}

/**
 * 生成完整历史中的已完成用户轮次，并标记当前摘要已经覆盖的轮次。
 * 压缩边界可能位于轮次内部；只要该轮仍有记录被逐字保留，就不标记为已压缩。
 */
export function projectConversationHistory(records: SessionRecord[]): Array<{
  turnId: string
  text: string
  compacted: boolean
}> {
  const visible = projectVisibleSessionRecords(records)
  const active = latestCompaction(records)
  const retainedTurnIds = new Set<string>()
  let firstKeptRecordIndex = -1
  if (active) {
    firstKeptRecordIndex = records.findIndex((record) => record.recordId === active.record.firstKeptRecordId)
    if (firstKeptRecordIndex >= 0 && firstKeptRecordIndex < active.index) {
      for (const record of records.slice(firstKeptRecordIndex))
        if ("turnId" in record) retainedTurnIds.add(record.turnId)
    }
  }
  return visible
    .filter((record): record is Extract<SessionRecord, { kind: "turn_started" }> => record.kind === "turn_started")
    .map((record) => {
      const recordIndex = records.findIndex((candidate) => candidate.recordId === record.recordId)
      const text = record.items
        .filter((item) => item.source === "user")
        .flatMap((item) => item.parts)
        .filter((part) => part.kind === "text")
        .map((part) => part.text.trim())
        .find(Boolean)
      return {
        turnId: record.turnId,
        text: text ?? "",
        compacted:
          !!active &&
          firstKeptRecordIndex >= 0 &&
          recordIndex >= 0 &&
          recordIndex < firstKeptRecordIndex &&
          !retainedTurnIds.has(record.turnId),
      }
    })
}
