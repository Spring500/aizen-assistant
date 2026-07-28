import { expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { runInteractiveApp } from "../../apps/tui/interactive-app.ts"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import { ModelConfigStore } from "../../packages/core/model-config-store.ts"
import { projectDirectoryName } from "../../packages/core/paths.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import type { CoreCommand, CoreEvent, CorePort, CoreSnapshot } from "../../packages/core/types.ts"
import { ViewStore } from "../../packages/core/view-store.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { copyAppFixture } from "../utils/app-fixture.ts"

const model = {
  providerId: "anthropic",
  modelId: "claude-sonnet-4-6",
  api: "anthropic-messages",
  thinkingLevel: "off",
  name: "Fixture Model",
  available: true,
}

class ThrowingCreateCore implements CorePort {
  readonly #listeners = new Set<(event: CoreEvent) => void>()
  readonly snapshot: CoreSnapshot = {
    cwd: "E:\\fixture",
    status: "idle",
    sessions: [],
    models: [model],
    views: [],
    authProviders: [{ id: "anthropic", name: "Anthropic", configured: true, supportsApiKey: true }],
    transcript: [],
    activeTools: [],
    streamingText: "",
    streamingThinking: "",
  }

  async dispatch(command: CoreCommand) {
    if (command.type === "create_session") throw new Error("fixture 创建抛出异常")
    return { ok: true as const }
  }
  subscribe(listener: (event: CoreEvent) => void) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  getSnapshot() {
    return structuredClone(this.snapshot)
  }
  dispose = async () => {}
}

function key(text: string): KeyEvent {
  const parsed = parseKeypress(text)
  if (!parsed) throw new Error(`无法解析按键：${JSON.stringify(text)}`)
  return new KeyEvent(parsed)
}

async function press(setup: Awaited<ReturnType<typeof createTestRenderer>>, sequence: string) {
  setup.renderer.keyInput.emit("keypress", key(sequence))
  await Bun.sleep(10)
  await setup.renderOnce()
}

async function pressEnter(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  await press(setup, "\r")
}

async function pressDown(setup: Awaited<ReturnType<typeof createTestRenderer>>, count = 1) {
  for (let index = 0; index < count; index++) await press(setup, "\x1b[B")
}

async function destroyTestRenderer(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  setup.renderer.destroy()
  // OpenTUI native teardown completes asynchronously on Windows CI.
  await Bun.sleep(100)
}

test("真实完整 TUI 链路：非法 models.json 的错误持续显示且不会返回会话选择", async () => {
  const root = await copyAppFixture("invalid-model")
  const setup = await createTestRenderer({
    width: 100,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 9,
    externalOutputMode: "capture-stdout",
    useThread: false,
  })
  const pi = await PiSessionRuntime.create({ authPath: `${root}/auth.json`, modelsPath: `${root}/models.json` })
  const core = new AizenCore({
    cwd: root,
    store: new SessionStore(`${root}/sessions/${projectDirectoryName(root)}`),
    pi,
    modelConfigStore: new ModelConfigStore(`${root}/models.json`),
    views: new ViewStore(`${root}/views.json`),
  })
  const running = runInteractiveApp({ cwd: root, dataDirectory: root, testing: { renderer: setup.renderer, core } })
  let firstFrame = ""
  let laterFrame = ""
  try {
    await Bun.sleep(20)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("会话设置 · 新建会话")
    await pressEnter(setup)
    await Bun.sleep(20)
    await setup.renderOnce()
    firstFrame = setup.captureCharFrame()
    await Bun.sleep(40)
    await setup.renderOnce()
    laterFrame = setup.captureCharFrame()
  } finally {
    setup.renderer.keyInput.emit("keypress", key("\x03"))
    await running
    await destroyTestRenderer(setup)
    await rm(root, { recursive: true, force: true })
  }
  expect(firstFrame).toContain("models.json")
  expect(firstFrame).not.toContain("选择会话")
  expect(laterFrame).toContain("models.json")
  expect(laterFrame).not.toContain("选择会话")
})

test("真实完整 TUI 链路：没有 views.json 时选择无视图并成功进入会话", async () => {
  const root = await copyAppFixture("empty")
  const setup = await createTestRenderer({
    width: 100,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 9,
    externalOutputMode: "capture-stdout",
    useThread: false,
  })
  const pi = await PiSessionRuntime.create({ authPath: `${root}/auth.json`, modelsPath: null })
  await pi.setRuntimeApiKey("anthropic", "fixture-key")
  const core = new AizenCore({
    cwd: root,
    store: new SessionStore(`${root}/sessions/${projectDirectoryName(root)}`),
    pi,
    modelConfigStore: new ModelConfigStore(`${root}/models.json`),
    views: new ViewStore(`${root}/views.json`),
  })
  const running = runInteractiveApp({ cwd: root, dataDirectory: root, testing: { renderer: setup.renderer, core } })
  try {
    await Bun.sleep(20)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("会话设置 · 新建会话")
    await pressEnter(setup)
    expect(setup.captureCharFrame()).toContain("选择供应商")
    await pressEnter(setup)
    expect(setup.captureCharFrame()).toContain("选择模型")
    await pressEnter(setup)
    expect(setup.captureCharFrame()).toContain("会话设置 · 新建会话")
    expect(setup.captureCharFrame()).toContain("anthropic")
    await pressDown(setup, 4)
    await pressEnter(setup)
    await Bun.sleep(30)
    await setup.renderOnce()

    expect(core.getSnapshot().currentSessionId).toBeDefined()
    expect(core.getSnapshot().currentViewId).toBeNull()
    expect(setup.captureCharFrame()).not.toContain("创建会话失败")
  } finally {
    setup.renderer.keyInput.emit("keypress", key("\x03"))
    await running
    await destroyTestRenderer(setup)
    await rm(root, { recursive: true, force: true })
  }
})

test("完整 TUI 链路：创建失败错误不会被选择无视图的 Enter 立即关闭", async () => {
  const setup = await createTestRenderer({
    width: 100,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 9,
    externalOutputMode: "capture-stdout",
    useThread: false,
  })
  const core = new ThrowingCreateCore()
  const running = runInteractiveApp({
    cwd: core.snapshot.cwd,
    dataDirectory: "unused",
    testing: { renderer: setup.renderer, core },
  })
  try {
    await Bun.sleep(10)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("会话设置 · 新建会话")

    await pressEnter(setup)
    expect(setup.captureCharFrame()).toContain("选择供应商")
    await pressEnter(setup)
    expect(setup.captureCharFrame()).toContain("选择模型")
    await pressEnter(setup)
    expect(setup.captureCharFrame()).toContain("会话设置 · 新建会话")
    await pressDown(setup, 4)
    await pressEnter(setup)
    await Bun.sleep(20)
    await setup.renderOnce()
    const errorFrame = setup.captureCharFrame()
    expect(errorFrame).toContain("创建会话失败")
    expect(errorFrame).toContain("fixture 创建抛出异常")

    await Bun.sleep(30)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("fixture 创建抛出异常")
  } finally {
    setup.renderer.keyInput.emit("keypress", key("\x03"))
    await Promise.race([running, Bun.sleep(1000)])
    await destroyTestRenderer(setup)
  }
})
