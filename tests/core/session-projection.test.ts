import { expect, test } from "bun:test"
import type { SessionRecord } from "../../packages/core/session-format.ts"
import { projectVisibleSessionRecords } from "../../packages/core/session-projection.ts"
import { recordsToTranscript } from "../../packages/core/types.ts"

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
