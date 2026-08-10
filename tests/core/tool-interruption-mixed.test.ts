import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import type { PiPort, PiPortEvent } from "../../packages/core/pi-port.ts"
import type { ModelReference, SessionRecord } from "../../packages/core/session-format.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const model: ModelReference = { providerId: "test", modelId: "model" }
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

function assistant(turnId: string): SessionRecord {
  return {
    kind: "message",
    recordId: "assistant",
    turnId,
    at: new Date().toISOString(),
    message: {
      role: "assistant",
      parts: [
        { kind: "tool_call", callId: "review", name: "review_tool", arguments: {} },
        { kind: "tool_call", callId: "running", name: "running_tool", arguments: {} },
      ],
      source: { providerId: "test", modelId: "model", api: "anthropic-messages" },
      stopReason: "toolUse",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
  }
}

test("多工具批次按各自持久化阶段恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-mixed-recovery-"))
  try {
    const store = new SessionStore(join(root, "sessions"))
    const at = new Date().toISOString()
    const turnId = "turn"
    const request = (callId: string, toolName: string) => ({
      sessionId: "session",
      turnId,
      toolCallId: callId,
      toolName,
      arguments: {},
      declaredIntent: "测试",
      cwd: root,
      mode: "hybrid",
    })
    const records: SessionRecord[] = [
      { kind: "model_changed", recordId: "model", at, model },
      { kind: "view_changed", recordId: "view", at, viewId: null },
      { kind: "turn_started", recordId: "turn", turnId, at, viewId: null, items: [] },
      assistant(turnId),
      {
        kind: "tool_permission",
        recordId: "review-requested",
        turnId,
        at,
        toolCallId: "review",
        event: { type: "permissionRequested", request: request("review", "review_tool"), batchId: "batch" },
      },
      {
        kind: "tool_permission",
        recordId: "running",
        turnId,
        at,
        toolCallId: "running",
        event: {
          phase: "executionStarted",
          request: request("running", "running_tool"),
          authorization: {
            type: "allow",
            source: "validator",
            arguments: {},
            assessment: { summary: "执行", targets: [], reason: "允许" },
          },
        },
      },
    ]
    const header = await store.createGenerated({ cwd: root, createdAt: at }, records)
    const core = new AizenCore({ cwd: root, store, pi: new RestorePi() })
    expect(await core.dispatch({ type: "open_session", sessionId: header.sessionId })).toEqual({ ok: true })
    const results = core
      .getSnapshot()
      .transcript.filter((entry) => entry.type === "message" && entry.message.role === "tool")
    expect(results).toHaveLength(2)
    expect(JSON.stringify(results)).toContain("Permission review did not complete")
    expect(JSON.stringify(results)).toContain("Execution started, but its outcome is unknown")
    expect(
      (await store.read(header.sessionId)).records.filter((record) => record.kind === "turn_finished"),
    ).toHaveLength(1)
    await core.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
