import { afterEach, expect } from "bun:test"
import { createDiagnosticTest } from "../../utils/diagnostic-test.ts"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonlPermissionGapRecorder } from "../../../packages/core/tool-permissions/gap-recorder.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

test("本地收集器按JSONL顺序写入并在关闭时清空队列", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-permission-gaps-"))
  directories.push(root)
  const path = join(root, "local-observations", "permission-gaps.jsonl")
  const recorder = new JsonlPermissionGapRecorder(path)
  const base = {
    version: 1 as const,
    at: "2026-08-04T00:00:00.000Z",
    sessionId: "session",
    turnId: "turn",
    permissionMode: "unrestricted" as const,
    toolName: "bash",
    declaredIntent: "测试记录",
    cwd: root,
    validatorDecision: "needAiReview" as const,
    gaps: [{ code: "bash.command-rule-miss", kind: "rule-miss" as const, summary: "规则未命中" }],
    arguments: { command: "find ." },
  }
  await Promise.all([
    recorder.record({ ...base, toolCallId: "first" }),
    recorder.record({ ...base, toolCallId: "second" }),
  ])
  await recorder.close()

  const records = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(records.map((record) => record.toolCallId)).toEqual(["first", "second"])
})
