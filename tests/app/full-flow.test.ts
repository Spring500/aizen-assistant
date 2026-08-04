import { afterEach, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { ActionQueue, dispatchOrPresent, sendPromptWithRecovery } from "../../apps/tui/action-runner.ts"
import { viewSelectionItems } from "../../apps/tui/view-flow.ts"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import type { PiPort, PiPortEvent } from "../../packages/core/pi-port.ts"
import type { ModelReference } from "../../packages/core/session-format.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import type { CoreCommand, CoreEvent, CorePort, CoreSnapshot } from "../../packages/core/types.ts"
import { ViewStore } from "../../packages/core/view-store.ts"
import { copyAppFixture } from "../utils/app-fixture.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const roots: string[] = []
const model: ModelReference = {
  providerId: "fixture",
  modelId: "fixture-model",
  api: "anthropic-messages",
  thinkingLevel: "off",
}

class FixturePi implements PiPort {
  create = async () => model
  restore = async () => model
  refreshView = async () => {}
  switchView = async () => model
  generateSessionTitle = async () => "测试标题"
  prompt = async () => {}
  abort = async () => {}
  listModels = async () => [{ ...model, name: "Fixture Model", available: true }]
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

class ThrowingCore implements CorePort {
  dispatch(_command: CoreCommand): Promise<never> {
    throw new Error("边界外异常")
  }
  subscribe(_listener: (event: CoreEvent) => void) {
    return () => {}
  }
  getSnapshot(): CoreSnapshot {
    throw new Error("unused")
  }
  dispose = async () => {}
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

test("完整业务链路：空配置仍列出无视图并创建会话", async () => {
  const root = await copyAppFixture("empty")
  roots.push(root)
  const views = new ViewStore(join(root, "views.json"))
  expect(await views.list()).toEqual([])
  const choices = viewSelectionItems(await views.list())
  expect(choices).toEqual([{ name: "无视图", description: "使用内建提示词，不加载 AGENTS.md 和 Skills", value: null }])

  const core = new AizenCore({ cwd: root, store: new SessionStore(join(root, "sessions")), pi: new FixturePi(), views })
  const result = await core.dispatch({ type: "create_session", model, viewId: choices[0]?.value ?? null })
  expect(result).toEqual({ ok: true })
  expect(core.getSnapshot().currentViewId).toBeNull()
  expect(core.getSnapshot().currentSessionId).toBeDefined()
  await core.dispose()
})

test("完整业务链路：固定有效和失效视图 fixture 保留真实目录语义", async () => {
  const validRoot = await copyAppFixture("valid-view")
  const invalidRoot = await copyAppFixture("invalid-view")
  roots.push(validRoot, invalidRoot)
  expect(await new ViewStore(join(validRoot, "views.json")).list()).toMatchObject([{ id: "review", valid: true }])
  expect(await new ViewStore(join(invalidRoot, "views.json")).list()).toMatchObject([{ id: "missing", valid: false }])
})

test("统一操作边界展示 dispatch 失败、直接 throw 和队列异常", async () => {
  const shown: Array<{ title: string; message: string }> = []
  const present = async (title: string, message: string) => {
    shown.push({ title, message })
  }
  const result = await dispatchOrPresent(new ThrowingCore(), { type: "list_sessions" }, "读取失败", present)
  expect(result).toEqual({
    ok: false,
    error: { code: "UNEXPECTED_ERROR", message: "边界外异常", severity: "error" },
  })

  const queue = new ActionQueue(present)
  queue.run(async () => {
    throw new Error("队列异常")
  })
  await queue.flush()
  expect(shown).toEqual([
    { title: "读取失败", message: "边界外异常" },
    { title: "操作失败", message: "队列异常" },
  ])
})

test("发送遇到模型失效时选择新模型并自动重试原文", async () => {
  const commands: CoreCommand[] = []
  const replacement = { ...model, modelId: "replacement", thinkingLevel: "high" }
  const core = {
    async dispatch(command: CoreCommand) {
      commands.push(command)
      if (command.type === "send_prompt" && commands.filter((item) => item.type === "send_prompt").length === 1)
        return {
          ok: false as const,
          error: { code: "MODEL_SELECTION_REQUIRED", message: "模型配置失效", severity: "error" as const },
        }
      return { ok: true as const }
    },
  } as CorePort
  const restored: string[] = []
  const shown: string[] = []

  expect(
    await sendPromptWithRecovery({
      core,
      text: "已经输入很久的消息",
      chooseModel: async () => replacement,
      chooseView: async () => undefined,
      present: async (_title, message) => {
        shown.push(message)
      },
      restoreDraft: (text) => restored.push(text),
    }),
  ).toEqual({ ok: true })
  expect(commands).toEqual([
    { type: "send_prompt", text: "已经输入很久的消息" },
    { type: "set_model", model: replacement },
    { type: "send_prompt", text: "已经输入很久的消息" },
  ])
  expect(restored).toEqual([])
  expect(shown).toEqual([])
})

test("用户取消模型选择时恢复原输入", async () => {
  const core = {
    async dispatch() {
      return {
        ok: false as const,
        error: { code: "MODEL_SELECTION_REQUIRED", message: "模型配置失效", severity: "error" as const },
      }
    },
  } as unknown as CorePort
  const restored: string[] = []
  await sendPromptWithRecovery({
    core,
    text: "不能丢失的原输入",
    chooseModel: async () => undefined,
    chooseView: async () => undefined,
    present: async () => {},
    restoreDraft: (text) => restored.push(text),
  })
  expect(restored).toEqual(["不能丢失的原输入"])
})

test("发送遇到视图失效时选择新视图并自动重试原文", async () => {
  const commands: CoreCommand[] = []
  const core = {
    async dispatch(command: CoreCommand) {
      commands.push(command)
      if (command.type === "send_prompt" && commands.filter((item) => item.type === "send_prompt").length === 1)
        return {
          ok: false as const,
          error: { code: "VIEW_SELECTION_REQUIRED", message: "视图目录不存在", severity: "error" as const },
        }
      return { ok: true as const }
    },
  } as CorePort
  const restored: string[] = []

  expect(
    await sendPromptWithRecovery({
      core,
      text: "保留的消息",
      chooseModel: async () => undefined,
      chooseView: async () => "replacement-view",
      present: async () => {},
      restoreDraft: (text) => restored.push(text),
    }),
  ).toEqual({ ok: true })
  expect(commands).toEqual([
    { type: "send_prompt", text: "保留的消息" },
    { type: "set_view", viewId: "replacement-view" },
    { type: "send_prompt", text: "保留的消息" },
  ])
  expect(restored).toEqual([])
})
