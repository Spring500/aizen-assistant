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
  expect(core.getSnapshot().lastError).toContain("异常退出时仍在执行")
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
  await core.dispose()
})
