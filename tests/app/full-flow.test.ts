import { afterEach, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { ActionQueue, dispatchOrPresent } from "../../apps/tui/action-runner.ts"
import { viewSelectionItems } from "../../apps/tui/view-flow.ts"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import type { PiPort, PiPortEvent } from "../../packages/core/pi-port.ts"
import type { ModelReference } from "../../packages/core/session-format.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import type { CoreCommand, CoreEvent, CorePort, CoreSnapshot } from "../../packages/core/types.ts"
import { ViewStore } from "../../packages/core/view-store.ts"
import { copyAppFixture } from "../utils/app-fixture.ts"

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
