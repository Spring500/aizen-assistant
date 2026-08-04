import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import type { PiPort, PiPortEvent } from "../../packages/core/pi-port.ts"
import type { ModelReference, SessionRecord } from "../../packages/core/session-format.ts"
import { SessionStore } from "../../packages/core/session-store.ts"

const directories: string[] = []
const model: ModelReference = { providerId: "test", modelId: "model", api: "anthropic-messages" }
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

class RestorePi implements PiPort {
  create = async () => model
  restore = async () => model
  refreshView = async () => {}
  switchView = async () => model
  generateSessionTitle = async () => "标题"
  prompt = async () => {}
  compact = async (_customInstructions?: string) => {}
  abort = async () => {}
  listModels = async () => []
  reloadModelConfig = async () => {}
  setModel = async () => model
  listAuthProviders = async () => []
  loginApiKey = async () => {}
  answerAuthPrompt = () => {}
  cancelAuth = () => {}
  subscribe(_listener: (event: PiPortEvent) => void) {
    return () => {}
  }
  dispose = async () => {}
}

test("恢复时把已批准但未开始的工具标记为未执行且不重试", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-permission-approved-recovery-"))
  directories.push(root)
  const store = new SessionStore(join(root, "sessions"))
  const at = new Date().toISOString()
  const records: SessionRecord[] = [
    { kind: "model_changed", recordId: "model", at, model },
    { kind: "view_changed", recordId: "view", at, viewId: null },
    { kind: "turn_started", recordId: "turn", turnId: "turn", at, viewId: null, items: [] },
    {
      kind: "message",
      recordId: "assistant",
      turnId: "turn",
      at,
      message: {
        role: "assistant",
        parts: [
          {
            kind: "tool_call",
            callId: "approved-call",
            name: "write",
            arguments: { path: "file.ts", content: "x" },
          },
        ],
        source: { providerId: "test", modelId: "model", api: "anthropic-messages" },
        stopReason: "toolUse",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    },
    {
      kind: "tool_permission",
      recordId: "approved",
      turnId: "turn",
      at,
      toolCallId: "approved-call",
      event: {
        type: "authorized",
        authorization: { type: "allow", source: "human", arguments: { path: "file.ts", content: "x" } },
      },
    },
  ]
  const header = await store.createGenerated({ cwd: root, createdAt: at }, records)
  const core = new AizenCore({ cwd: root, store, pi: new RestorePi() })
  expect(await core.dispatch({ type: "open_session", sessionId: header.sessionId })).toEqual({ ok: true })
  const loaded = await store.read(header.sessionId)
  const result = loaded.records.find(
    (record) =>
      record.kind === "message" && record.message.role === "tool" && record.message.callId === "approved-call",
  )
  if (result?.kind === "message" && result.message.role === "tool") {
    expect(result.message.details).toMatchObject({ interrupted: true, executionStarted: false })
    expect(result.message.parts[0]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("The tool was authorized but did not start"),
    })
  }
  expect(
    loaded.records.some(
      (record) =>
        record.kind === "tool_permission" &&
        !!record.event &&
        typeof record.event === "object" &&
        !Array.isArray(record.event) &&
        record.event.type === "interruptedBeforeStart",
    ),
  ).toBe(true)
  await core.dispose()
})

test("恢复时把已开始但未结束的工具标记为需先检查而不自动重试", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-interrupted-"))
  directories.push(root)
  const store = new SessionStore(join(root, "sessions"))
  const at = new Date().toISOString()
  const records: SessionRecord[] = [
    { kind: "model_changed", recordId: "model", at, model },
    { kind: "view_changed", recordId: "view", at, viewId: null },
    { kind: "permission_mode_changed", recordId: "mode", at, permissionMode: "hybrid" },
    {
      kind: "turn_started",
      recordId: "turn-started",
      turnId: "turn",
      at,
      viewId: null,
      permissionMode: "hybrid",
      items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "执行工具" }] }],
    },
    {
      kind: "message",
      recordId: "assistant",
      turnId: "turn",
      at,
      message: {
        role: "assistant",
        parts: [{ kind: "tool_call", callId: "call", name: "write", arguments: { path: "file.ts", content: "x" } }],
        source: { providerId: "test", modelId: "model", api: "anthropic-messages" },
        stopReason: "toolUse",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    },
    {
      kind: "tool_permission",
      recordId: "started",
      turnId: "turn",
      at,
      toolCallId: "call",
      event: {
        phase: "executionStarted",
        authorization: {
          assessment: { recoveryChecks: ["检查目标文件内容"] },
        },
      },
    },
  ]
  const header = await store.createGenerated({ cwd: root, createdAt: at }, records)
  const core = new AizenCore({ cwd: root, store, pi: new RestorePi() })
  expect(await core.dispatch({ type: "open_session", sessionId: header.sessionId })).toEqual({ ok: true })
  expect(core.getSnapshot().lastError).toContain("存在未完成的工具调用")
  const loaded = await store.read(header.sessionId)
  const recovery = loaded.records.find(
    (record) =>
      record.kind === "tool_permission" &&
      !!record.event &&
      typeof record.event === "object" &&
      !Array.isArray(record.event) &&
      record.event.type === "interruptedAfterStart",
  )
  expect(recovery).toMatchObject({
    kind: "tool_permission",
    toolCallId: "call",
    event: { recoveryChecks: ["检查目标文件内容"] },
  })
  const interruptedResult = loaded.records.find(
    (record) => record.kind === "message" && record.message.role === "tool" && record.message.callId === "call",
  )
  expect(interruptedResult).toMatchObject({
    message: { isError: true, details: { interrupted: true, executionStarted: true } },
  })
  if (interruptedResult?.kind === "message" && interruptedResult.message.role === "tool")
    expect(interruptedResult.message.parts[0]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("Operation interrupted:"),
    })
  expect(loaded.records.at(-1)).toMatchObject({ kind: "turn_finished", outcome: "failed" })
  expect(
    core
      .getSnapshot()
      .transcript.some(
        (entry) => entry.type === "message" && entry.message.role === "tool" && entry.message.callId === "call",
      ),
  ).toBe(true)
  await core.dispose()
})
