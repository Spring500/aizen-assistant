import { afterEach, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { exists, mkdtemp, readFile, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { startMockServer } from "../utils/mock-server.ts"

const test = createDiagnosticTest({ timeoutMs: 30_000 })

const directories: string[] = []
const workerPath = join(import.meta.dir, "tool-interruption-worker.ts")

type Checkpoint =
  | "assistantMessage"
  | "permissionRequested"
  | "validated"
  | "authorized"
  | "authorizedDenied"
  | "executionStarted"
  | "toolSideEffect"
  | "executionFinished"
  | "executionFailed"
  | "toolMessage"

type Case = {
  checkpoint: Checkpoint
  expected: string
  sideEffect: boolean
  isError: boolean
}

const cases: Case[] = [
  {
    checkpoint: "assistantMessage",
    expected:
      "Operation interrupted: The application stopped before permission review started, so the tool did not run. Submit a new tool call only if it is still needed.",
    sideEffect: false,
    isError: true,
  },
  {
    checkpoint: "permissionRequested",
    expected:
      "Operation interrupted: Permission review did not complete, so the tool did not run. Submit a new tool call only if it is still needed.",
    sideEffect: false,
    isError: true,
  },
  {
    checkpoint: "authorized",
    expected:
      "Operation interrupted: The tool was authorized but did not start. Submit a new tool call if it is still needed.",
    sideEffect: false,
    isError: true,
  },
  {
    checkpoint: "authorizedDenied",
    expected: `Operation denied: rule "Unsafe operation" is not allowed. This call matched it because: 测试拒绝执行\n\nThe tool did not run.`,
    sideEffect: false,
    isError: true,
  },
  {
    checkpoint: "executionStarted",
    expected:
      "Operation interrupted: Execution started, but its outcome is unknown. Verify the target state before retrying or making further changes.",
    sideEffect: false,
    isError: true,
  },
  {
    checkpoint: "toolSideEffect",
    expected:
      "Operation interrupted: Execution started, but its outcome is unknown. Verify the target state before retrying or making further changes.",
    sideEffect: true,
    isError: true,
  },
  {
    checkpoint: "executionFinished",
    expected:
      "Operation interrupted: The tool completed, but its result was lost. Verify the target state before repeating the operation.",
    sideEffect: true,
    isError: true,
  },
  {
    checkpoint: "executionFailed",
    expected: `Operation failed: 测试工具产生部分影响后失败\n\nVerify the target state before retrying because the operation may have had partial effects.`,
    sideEffect: true,
    isError: true,
  },
  {
    checkpoint: "toolMessage",
    expected: "checkpoint completed",
    sideEffect: true,
    isError: false,
  },
]

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function waitForFile(path: string, process: Bun.Subprocess, trace: (stage: string) => void): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await exists(path)) {
      trace("检查点文件已可见")
      return
    }
    // 进程被外部终止（如 bun 测试运行器清理悬空子进程）时 exitCode 可能保持 null，
    // 必须同时检查 signalCode / killed，否则会误等满超时窗口。
    if (process.exitCode !== null || process.signalCode !== null || process.killed)
      throw new Error(
        `检查点 worker 提前退出：exitCode=${process.exitCode} signalCode=${process.signalCode} killed=${process.killed}`,
      )
    await Bun.sleep(10)
  }
  trace("等待检查点超时")
  throw new Error(`等待检查点超时：${path}`)
}

function toolResultFromRequest(messages: unknown[]): { callId: string; text: string; isError: boolean } | undefined {
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue
      const source = part as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown }
      if (source.type !== "tool_result" || typeof source.tool_use_id !== "string") continue
      const text =
        typeof source.content === "string"
          ? source.content
          : Array.isArray(source.content)
            ? source.content
                .filter(
                  (item): item is { type: "text"; text: string } =>
                    !!item && typeof item === "object" && !Array.isArray(item) && "type" in item && "text" in item,
                )
                .map((item) => item.text)
                .join("\n")
            : ""
      return { callId: source.tool_use_id, text, isError: source.is_error === true }
    }
  }
  return undefined
}

for (const scenario of cases) {
  test(`进程异常退出后恢复工具阶段：${scenario.checkpoint}`, async () => {
    const startedAt = performance.now()
    const trace = (stage: string) =>
      console.log(
        `[工具中断/${scenario.checkpoint}/parent] ${stage}，累计耗时 ${Math.round(performance.now() - startedAt)}ms`,
      )
    trace("开始")
    const root = await mkdtemp(join(tmpdir(), `aizen-interruption-${scenario.checkpoint}-`))
    directories.push(root)
    const readyPath = join(root, "checkpoint.ready")
    const sessionIdPath = join(root, "session-id.txt")
    const mock = await startMockServer({ modelBehaviors: { "claude-sonnet-4-6": "test-control" } })
    let requestSequence = 0
    mock.handle(async () => {
      requestSequence += 1
      if (requestSequence === 1)
        return {
          type: "tool_call",
          name: "checkpoint_tool",
          arguments: { declaredIntent: "验证异常恢复" },
          callId: "checkpoint-call",
        }
      await new Promise<void>(() => {})
      return { type: "text", text: "不会到达" }
    })
    trace("启动 worker")
    const worker = Bun.spawn(
      [
        process.execPath,
        "run",
        workerPath,
        JSON.stringify({ root, mockUrl: mock.url, checkpoint: scenario.checkpoint, readyPath, sessionIdPath }),
      ],
      { stdout: "inherit", stderr: "inherit" },
    )
    try {
      await waitForFile(readyPath, worker, trace)
      trace("终止 worker")
      worker.kill()
      const workerExitCode = await worker.exited
      trace(`worker 已退出：${workerExitCode}`)
      const sessionId = await readFile(sessionIdPath, "utf8")
      expect(await exists(join(root, "effect.txt"))).toBe(scenario.sideEffect)

      // worker 已确认退出，其持有的会话锁目录必然残留且心跳不再更新。proper-lockfile
      // 需等待 stale（10 秒）窗口才会判定锁过期；这里把锁目录的 mtime 主动改到 stale
      // 窗口之前，使恢复路径立即走正常的“锁过期→抢占”流程，避免每个中断场景空等约 10 秒
      // （10 个场景累计约 100 秒的 CI 时间）。锁路径规则见 SessionStore 的 #lockPath。
      const staleEpoch = new Date(Date.now() - 12_000)
      await utimes(join(root, "sessions", `.${encodeURIComponent(sessionId)}.session.lock`), staleEpoch, staleEpoch)

      mock.handle(() => ({ type: "text", text: "恢复后继续" }))
      const pi = await PiSessionRuntime.create({ authPath: join(root, "auth.json"), customProvidersPath: null })
      await pi.setRuntimeApiKey("anthropic", "test-key")
      const model = (await pi.listModels()).find(
        (item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6",
      )
      if (!model) throw new Error("缺少测试模型")
      pi.setModelBaseUrl(model.providerId, model.modelId, mock.url)
      const store = new SessionStore(join(root, "sessions"))
      let crashed: Awaited<ReturnType<SessionStore["open"]>> | undefined
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          crashed = await store.open(sessionId)
          break
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("会话正在被其他 Agent 使用")) throw error
          await Bun.sleep(500)
        }
      }
      if (!crashed) throw new Error("异常退出后的会话锁未在预期时间内释放")
      if (scenario.checkpoint === "authorized" || scenario.checkpoint === "authorizedDenied") {
        expect(
          crashed.records.some(
            (record) =>
              record.kind === "tool_permission" &&
              !!record.event &&
              typeof record.event === "object" &&
              !Array.isArray(record.event) &&
              record.event.type === "authorized" &&
              !!record.event.authorization,
          ),
        ).toBe(true)
      }
      const core = new AizenCore({ cwd: root, store, pi })
      expect(await core.dispatch({ type: "open_session", sessionId })).toEqual({ ok: true })
      const userToolResults = core
        .getSnapshot()
        .transcript.filter(
          (entry) =>
            entry.type === "message" && entry.message.role === "tool" && entry.message.callId === "checkpoint-call",
        )
      expect(userToolResults).toHaveLength(1)
      const userResult = userToolResults[0]
      if (userResult?.type !== "message" || userResult.message.role !== "tool") throw new Error("缺少用户侧工具结果")
      expect(userResult.message.parts).toEqual([{ kind: "text", text: scenario.expected }])
      expect(userResult.message.isError).toBe(scenario.isError)

      expect(await core.dispatch({ type: "send_prompt", text: "恢复后检查上下文" })).toEqual({ ok: true })
      const requests = await mock.requests()
      const recoveredRequest = requests.at(-1)
      if (!recoveredRequest) throw new Error("MockServer 没有收到恢复后的请求")
      const agentResult = toolResultFromRequest(recoveredRequest.messages)
      expect(agentResult).toEqual({ callId: "checkpoint-call", text: scenario.expected, isError: scenario.isError })
      await core.dispose()

      const beforeSecondOpen = (await store.read(sessionId)).records.length
      const secondPi = await PiSessionRuntime.create({ authPath: join(root, "auth.json"), customProvidersPath: null })
      await secondPi.setRuntimeApiKey("anthropic", "test-key")
      secondPi.setModelBaseUrl(model.providerId, model.modelId, mock.url)
      const secondCore = new AizenCore({ cwd: root, store, pi: secondPi })
      expect(await secondCore.dispatch({ type: "open_session", sessionId })).toEqual({ ok: true })
      expect((await store.read(sessionId)).records).toHaveLength(beforeSecondOpen)
      await secondCore.dispose()
      trace("恢复验证完成")
    } finally {
      trace("开始清理")
      if (worker.exitCode === null) worker.kill()
      mock.stop()
      trace("清理完成")
    }
  })
}
