import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import type { SessionRecord } from "../../packages/core/session-format.ts"
import { projectVisibleSessionRecords, workingDirectoryChangeText } from "../../packages/core/session-projection.ts"
import { recordsToTranscript } from "../../packages/core/types.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const at = "2026-08-04T00:00:00.000Z"
const records: SessionRecord[] = [
  {
    kind: "turn_started",
    recordId: "unfinished-input",
    turnId: "unfinished",
    at,
    viewId: null,
    items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "不应显示" }] }],
  },
  {
    kind: "turn_started",
    recordId: "finished-input",
    turnId: "finished",
    at,
    viewId: null,
    items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "应显示" }] }],
  },
  {
    kind: "message",
    recordId: "finished-tool",
    turnId: "finished",
    at,
    message: {
      role: "tool",
      callId: "call",
      name: "demo",
      parts: [{ kind: "text", text: "共享结果" }],
      isError: true,
    },
  },
  { kind: "turn_finished", recordId: "finished", turnId: "finished", at, outcome: "failed" },
]

test("用户转录与Agent恢复共同使用完成轮次投影", () => {
  const visible = projectVisibleSessionRecords(records)
  const transcript = recordsToTranscript(visible)
  expect(visible.some((record) => "turnId" in record && record.turnId === "unfinished")).toBe(false)
  expect(
    transcript.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "tool" &&
        entry.message.parts.some((part) => part.kind === "text" && part.text === "共享结果"),
    ),
  ).toBe(true)
})

test("连续目录变更在下一轮对话前合并", () => {
  const changes: SessionRecord[] = [
    { kind: "working_directory_changed", recordId: "a-b", at, previousCwd: "A", currentCwd: "B" },
    {
      kind: "model_changed",
      recordId: "metadata",
      at,
      model: { providerId: "test", modelId: "model", api: "anthropic-messages" },
    },
    { kind: "working_directory_changed", recordId: "b-c", at, previousCwd: "B", currentCwd: "C" },
    {
      kind: "turn_started",
      recordId: "turn-c",
      turnId: "turn-c",
      at,
      viewId: null,
      items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "在 C 对话" }] }],
    },
    { kind: "turn_finished", recordId: "finished-c", turnId: "turn-c", at, outcome: "completed" },
    { kind: "working_directory_changed", recordId: "c-d", at, previousCwd: "C", currentCwd: "D" },
  ]

  expect(projectVisibleSessionRecords(changes)).toEqual([
    expect.objectContaining({ kind: "model_changed", recordId: "metadata" }),
    { kind: "working_directory_changed", recordId: "b-c", at, previousCwd: "A", currentCwd: "C" },
    expect.objectContaining({ kind: "turn_started", recordId: "turn-c" }),
    expect.objectContaining({ kind: "turn_finished", recordId: "finished-c" }),
    expect.objectContaining({ kind: "working_directory_changed", recordId: "c-d" }),
  ])
  expect(workingDirectoryChangeText("A", "C")).toBe('Working directory changed from "A" to "C".')
})
