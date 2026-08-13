import { afterEach, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import type { PiPort, PiPortEvent, RuntimeContextReport } from "../../packages/core/pi-port.ts"
import type { ModelReference } from "../../packages/core/session-format.ts"
import { InvalidSessionRecordError, SessionStore } from "../../packages/core/session-store.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const model: ModelReference = {
  providerId: "test",
  modelId: "model",
}

class FakePi implements PiPort {
  listeners = new Set<(event: PiPortEvent) => void>()
  create = async () => model
  restore = async () => model
  refreshView = async () => {}
  switchView = async () => model
  generateSessionTitle = async () => "标题"
  compact = async () => {}
  abort = async () => {}
  listModels = async () => [{ ...model, name: "m", available: true }]
  reloadModelConfig = async () => {}
  setModel = async () => model
  listAuthProviders = async () => []
  loginApiKey = async () => {}
  answerAuthPrompt = () => {}
  cancelAuth = () => {}
  describeRuntime = async (): Promise<RuntimeContextReport> => {
    throw new Error("describeRuntime 未实现")
  }
  dispose = async () => {}
  subscribe(listener: (event: PiPortEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async prompt() {
    for (const listener of this.listeners) {
      listener({
        type: "message",
        recordId: crypto.randomUUID(),
        record: {
          role: "assistant",
          parts: [{ kind: "text", text: "回复" }],
          source: { providerId: "test", modelId: "model", api: "anthropic-messages" },
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      })
      listener({ type: "settled" })
    }
  }
}

/** 仅让第一条消息记录因"本身非法"失败，其余正常。 */
class InvalidRecordStore extends SessionStore {
  invalidAttempts = 0

  override append(sessionId: string, record: Parameters<SessionStore["append"]>[1]): Promise<void> {
    if (record.kind === "message" && this.invalidAttempts === 0) {
      this.invalidAttempts++
      return Promise.reject(new InvalidSessionRecordError("工具调用内容块.declaredIntent 必须为 1 至 50 个字符"))
    }
    return super.append(sessionId, record)
  }
}

test("单条非法记录被跳过并告警，会话不锁死且后续轮次正常", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-invalid-record-"))
  directories.push(root)
  const store = new InvalidRecordStore(join(root, "sessions"))
  const core = new AizenCore({ cwd: root, store, pi: new FakePi() })
  await core.dispatch({ type: "create_session", model, viewId: null })
  const sessionId = core.getSnapshot().currentSessionId ?? ""

  // 第一条消息被判定非法：应降级跳过，而不是锁死会话
  const first = await core.dispatch({ type: "send_prompt", text: "第一条" })
  expect(first.ok).toBe(true)
  for (let attempt = 0; attempt < 20 && !core.getSnapshot().lastError; attempt++) await Bun.sleep(5)
  expect(core.getSnapshot().lastError).toContain("已跳过无效的会话记录")

  // 第二条消息正常：会话未锁死
  const second = await core.dispatch({ type: "send_prompt", text: "第二条" })
  expect(second.ok).toBe(true)
  const loaded = await store.read(sessionId)
  const messages = loaded.records.filter((record) => record.kind === "message")
  expect(messages).toHaveLength(1)
  await core.dispose()
})
