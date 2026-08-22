import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import type { SessionRecord, TurnInputItem } from "../../packages/core/session-format.ts"
import { projectConversationHistory, projectCurrentTranscriptRecords } from "../../packages/core/session-projection.ts"
import { recordsToTranscript } from "../../packages/core/types.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })
const at = "2026-08-08T00:00:00.000Z"

function input(turnId: string, recordId: string, text: string): SessionRecord {
  const items: TurnInputItem[] = [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text }] }]
  return { kind: "turn_started", recordId, turnId, at, viewId: null, items }
}

function finish(turnId: string, recordId: string): SessionRecord {
  return { kind: "turn_finished", recordId, turnId, at, outcome: "completed" }
}

const firstTurn: SessionRecord[] = [input("old", "old-user", "旧问题"), finish("old", "old-finished")]
const recentTurn: SessionRecord[] = [input("recent", "recent-user", "近期问题"), finish("recent", "recent-finished")]
const laterTurn: SessionRecord[] = [input("later", "later-user", "后续问题"), finish("later", "later-finished")]

test("主对话在压缩后只显示当前摘要、保留记录和后续记录", () => {
  const records: SessionRecord[] = [
    ...firstTurn,
    ...recentTurn,
    {
      kind: "compaction",
      recordId: "compact-1",
      at,
      summary: "当前摘要",
      firstKeptRecordId: "recent-user",
      tokensBefore: 1000,
    },
    ...laterTurn,
  ]

  const transcript = recordsToTranscript(projectCurrentTranscriptRecords(records))
  expect(JSON.stringify(transcript)).not.toContain("旧问题")
  expect(JSON.stringify(transcript)).toContain("当前摘要")
  expect(JSON.stringify(transcript)).toContain("近期问题")
  expect(JSON.stringify(transcript)).toContain("后续问题")
})

test("多次压缩后主对话只显示最新摘要", () => {
  const records: SessionRecord[] = [
    ...firstTurn,
    {
      kind: "compaction",
      recordId: "compact-1",
      at,
      summary: "旧摘要",
      firstKeptRecordId: "old-user",
      tokensBefore: 1000,
    },
    ...recentTurn,
    {
      kind: "compaction",
      recordId: "compact-2",
      at,
      summary: "最新摘要",
      firstKeptRecordId: "recent-user",
      tokensBefore: 2000,
    },
  ]

  const transcript = recordsToTranscript(projectCurrentTranscriptRecords(records))
  expect(JSON.stringify(transcript)).not.toContain("旧摘要")
  expect(JSON.stringify(transcript)).toContain("最新摘要")
  expect(JSON.stringify(transcript)).toContain("近期问题")
})

test("完整历史保留所有轮次并标记当前摘要覆盖的轮次", () => {
  const records: SessionRecord[] = [
    ...firstTurn,
    ...recentTurn,
    {
      kind: "compaction",
      recordId: "compact-1",
      at,
      summary: "当前摘要",
      firstKeptRecordId: "recent-user",
      tokensBefore: 1000,
    },
    ...laterTurn,
  ]

  expect(projectConversationHistory(records)).toEqual([
    expect.objectContaining({ turnId: "old", compacted: true }),
    expect.objectContaining({ turnId: "recent", compacted: false }),
    expect.objectContaining({ turnId: "later", compacted: false }),
  ])
})

test("压缩边界位于轮次内部时该轮仍视为原文保留", () => {
  const records: SessionRecord[] = [
    input("partial", "partial-user", "边界轮次"),
    {
      kind: "message",
      recordId: "partial-assistant",
      turnId: "partial",
      at,
      message: {
        role: "assistant",
        parts: [{ kind: "text", text: "保留的回复" }],
        source: { providerId: "test", modelId: "model", api: "test" },
        stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    },
    finish("partial", "partial-finished"),
    {
      kind: "compaction",
      recordId: "compact-1",
      at,
      summary: "当前摘要",
      firstKeptRecordId: "partial-assistant",
      tokensBefore: 1000,
    },
  ]

  const transcript = recordsToTranscript(projectCurrentTranscriptRecords(records))
  expect(JSON.stringify(transcript)).not.toContain("边界轮次")
  expect(JSON.stringify(transcript)).toContain("保留的回复")
  expect(projectConversationHistory(records)).toEqual([
    expect.objectContaining({ turnId: "partial", compacted: false }),
  ])
})
