import { rm } from "node:fs/promises"
import { KeyEvent, parseKeypress } from "@opentui/core"
import type { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { runInteractiveApp } from "../../apps/tui/interactive-app.ts"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import { defaultAppPreferences } from "../../packages/core/app-preferences-store.ts"
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
  readonly snapshot: CoreSnapshot = {
    cwd: "E:\\fixture",
    status: "idle",
    sessions: [],
    models: [model],
    preferences: structuredClone(defaultAppPreferences),
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
  subscribe(_listener: (event: CoreEvent) => void) {
    return () => {}
  }
  getSnapshot() {
    return structuredClone(this.snapshot)
  }
  dispose = async () => {}
}

class RecoverablePromptCore implements CorePort {
  readonly commands: CoreCommand[] = []
  readonly listeners = new Set<(event: CoreEvent) => void>()
  readonly snapshot: CoreSnapshot = {
    cwd: "E:\\fixture",
    status: "idle",
    sessions: [],
    currentSessionId: "fixture-session",
    currentSessionName: "恢复测试",
    currentModel: { ...model, thinkingLevel: "旧档位" },
    currentViewId: null,
    runtimeIssue: { kind: "model", message: "模型思考档位已失效" },
    models: [{ ...model, thinkingLevel: "标准", thinkingLevels: ["快速", "标准"] }],
    modelConfig: {
      revision: "fixture",
      providers: [],
      apiChoices: ["anthropic-messages"],
      inputModalities: [{ value: "text", enabled: true }],
      outputModalities: [],
    },
    preferences: structuredClone(defaultAppPreferences),
    views: [],
    authProviders: [{ id: "anthropic", name: "Anthropic", configured: true, supportsApiKey: true }],
    transcript: [],
    activeTools: [],
    streamingText: "",
    streamingThinking: "",
  }

  async dispatch(command: CoreCommand) {
    this.commands.push(command)
    const sendCount = this.commands.filter((item) => item.type === "send_prompt").length
    if (command.type === "send_prompt" && sendCount === 1)
      return {
        ok: false as const,
        error: { code: "MODEL_SELECTION_REQUIRED", message: "模型思考档位已失效", severity: "error" as const },
      }
    if (command.type === "set_model") {
      this.snapshot.currentModel = { ...command.model }
      delete this.snapshot.runtimeIssue
    }
    for (const listener of this.listeners) listener({ type: "snapshot", snapshot: this.getSnapshot() })
    return { ok: true as const }
  }
  subscribe(listener: (event: CoreEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot() {
    return structuredClone(this.snapshot)
  }
  dispose = async () => {}
}

class RecoverableViewPromptCore extends RecoverablePromptCore {
  constructor() {
    super()
    this.snapshot.currentViewId = "deleted-view"
    this.snapshot.runtimeIssue = { kind: "view", message: "视图目录不存在" }
    this.snapshot.views = [
      {
        id: "replacement-view",
        name: "替代视图",
        path: "E:\\fixture\\replacement-view",
        directory: "E:\\fixture\\replacement-view",
        valid: true,
      },
    ]
  }

  override async dispatch(command: CoreCommand) {
    this.commands.push(command)
    const sendCount = this.commands.filter((item) => item.type === "send_prompt").length
    if (command.type === "send_prompt" && sendCount === 1)
      return {
        ok: false as const,
        error: { code: "VIEW_SELECTION_REQUIRED", message: "视图目录不存在", severity: "error" as const },
      }
    if (command.type === "set_view") {
      this.snapshot.currentViewId = command.viewId
      delete this.snapshot.runtimeIssue
    }
    for (const listener of this.listeners) listener({ type: "snapshot", snapshot: this.getSnapshot() })
    return { ok: true as const }
  }
}

function assertIncludes(frame: string, value: string): void {
  if (!frame.includes(value)) throw new Error(`界面不包含 ${JSON.stringify(value)}：\n${frame}`)
}

function assertExcludes(frame: string, value: string): void {
  if (frame.includes(value)) throw new Error(`界面不应包含 ${JSON.stringify(value)}：\n${frame}`)
}

function key(text: string): KeyEvent {
  const parsed = parseKeypress(text)
  if (!parsed) throw new Error(`无法解析按键：${JSON.stringify(text)}`)
  return new KeyEvent(parsed)
}

async function setupRenderer() {
  return createTestRenderer({
    width: 100,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 9,
    externalOutputMode: "capture-stdout",
  })
}

async function press(setup: Awaited<ReturnType<typeof createTestRenderer>>, sequence: string) {
  setup.renderer.keyInput.emit("keypress", key(sequence))
  await Bun.sleep(10)
  await setup.renderOnce()
}

async function waitForCondition(condition: () => boolean, description: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(10)
  }
  throw new Error(`等待状态超时：${description}`)
}

async function waitForText(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  expected: string,
  timeoutMs = 1000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let frame = ""
  while (Date.now() < deadline) {
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    if (frame.includes(expected)) return frame
    await Bun.sleep(10)
  }
  throw new Error(`等待界面内容超时：${JSON.stringify(expected)}\n${frame}`)
}

const pressEnter = (setup: Awaited<ReturnType<typeof createTestRenderer>>) => press(setup, "\r")
async function pressDown(setup: Awaited<ReturnType<typeof createTestRenderer>>, count: number) {
  for (let index = 0; index < count; index++) await press(setup, "\x1b[B")
}

async function invalidModel(): Promise<void> {
  const root = await copyAppFixture("invalid-model")
  const setup = await setupRenderer()
  const pi = await PiSessionRuntime.create({ authPath: `${root}/auth.json`, modelsPath: `${root}/models.json` })
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
    assertIncludes(setup.captureCharFrame(), "会话设置 · 新建会话")
    await pressEnter(setup)
    await Bun.sleep(20)
    await setup.renderOnce()
    const first = setup.captureCharFrame()
    await Bun.sleep(40)
    await setup.renderOnce()
    const later = setup.captureCharFrame()
    assertIncludes(first, "models.json")
    assertExcludes(first, "选择会话")
    assertIncludes(later, "models.json")
    assertExcludes(later, "选择会话")
  } finally {
    setup.renderer.keyInput.emit("keypress", key("\x03"))
    await running
    setup.renderer.destroy()
    await rm(root, { recursive: true, force: true })
  }
}

async function noViews(): Promise<void> {
  const root = await copyAppFixture("empty")
  const setup = await setupRenderer()
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
    await waitForText(setup, "会话设置 · 新建会话")
    await pressEnter(setup)
    await waitForText(setup, "选择供应商")
    await pressEnter(setup)
    await waitForText(setup, "选择模型")
    await pressEnter(setup)
    await waitForText(setup, "选择思考档位")
    await pressEnter(setup)
    await waitForText(setup, "会话设置 · 新建会话")
    await pressDown(setup, 4)
    await pressEnter(setup)
    await waitForCondition(() => !!core.getSnapshot().currentSessionId, "创建会话")
    await setup.renderOnce()
    if (core.getSnapshot().currentViewId !== null) throw new Error("无视图没有生效")
    assertExcludes(setup.captureCharFrame(), "创建会话失败")
  } finally {
    setup.renderer.keyInput.emit("keypress", key("\x03"))
    await running
    setup.renderer.destroy()
    await rm(root, { recursive: true, force: true })
  }
}

async function throwingCreate(): Promise<void> {
  const setup = await setupRenderer()
  const core = new ThrowingCreateCore()
  const running = runInteractiveApp({
    cwd: core.snapshot.cwd,
    dataDirectory: "unused",
    testing: { renderer: setup.renderer, core },
  })
  try {
    await Bun.sleep(10)
    await setup.renderOnce()
    await pressEnter(setup)
    await pressEnter(setup)
    await pressEnter(setup)
    await pressDown(setup, 4)
    await pressEnter(setup)
    await Bun.sleep(20)
    await setup.renderOnce()
    assertIncludes(setup.captureCharFrame(), "创建会话失败")
    assertIncludes(setup.captureCharFrame(), "fixture 创建抛出异常")
    await Bun.sleep(30)
    await setup.renderOnce()
    assertIncludes(setup.captureCharFrame(), "fixture 创建抛出异常")
  } finally {
    setup.renderer.keyInput.emit("keypress", key("\x03"))
    await Promise.race([running, Bun.sleep(1000)])
    setup.renderer.destroy()
  }
}

async function recoverPrompt(): Promise<void> {
  const setup = await setupRenderer()
  const core = new RecoverablePromptCore()
  const running = runInteractiveApp({
    cwd: core.snapshot.cwd,
    dataDirectory: "unused",
    testing: { renderer: setup.renderer, core },
  })
  try {
    await waitForCondition(() => core.commands.some((command) => command.type === "load_preferences"), "应用启动")
    const editor = setup.renderer.root.getRenderable("editor") as TextareaRenderable | undefined
    if (!editor) throw new Error("找不到聊天输入框")
    editor.setText("保留并自动重试的消息")
    await pressEnter(setup)
    await waitForText(setup, "选择供应商")
    await pressEnter(setup)
    await waitForText(setup, "选择模型")
    await pressEnter(setup)
    await waitForText(setup, "选择思考档位")
    await pressEnter(setup)
    await waitForCondition(
      () => core.commands.filter((command) => command.type === "send_prompt").length === 2,
      "自动重试原消息",
    )
    const sends = core.commands.filter((command) => command.type === "send_prompt")
    if (sends.some((command) => command.type !== "send_prompt" || command.text !== "保留并自动重试的消息"))
      throw new Error("自动重试没有保留原消息")
    const selected = core.commands.find((command) => command.type === "set_model")
    if (selected?.type !== "set_model" || selected.model.thinkingLevel !== "快速")
      throw new Error("没有应用重新选择的思考档位")
  } finally {
    setup.renderer.keyInput.emit("keypress", key("\x03"))
    await running
    setup.renderer.destroy()
  }
}

async function recoverViewPrompt(): Promise<void> {
  const setup = await setupRenderer()
  const core = new RecoverableViewPromptCore()
  const running = runInteractiveApp({
    cwd: core.snapshot.cwd,
    dataDirectory: "unused",
    testing: { renderer: setup.renderer, core },
  })
  try {
    await waitForCondition(() => core.commands.some((command) => command.type === "load_preferences"), "应用启动")
    const editor = setup.renderer.root.getRenderable("editor") as TextareaRenderable | undefined
    if (!editor) throw new Error("找不到聊天输入框")
    editor.setText("视图修复后重试的消息")
    await pressEnter(setup)
    await waitForText(setup, "选择视图")
    await press(setup, "\x1b[B")
    await pressEnter(setup)
    await waitForCondition(
      () => core.commands.filter((command) => command.type === "send_prompt").length === 2,
      "切换视图后自动重试原消息",
    )
    const selected = core.commands.find((command) => command.type === "set_view")
    if (selected?.type !== "set_view" || selected.viewId !== "replacement-view")
      throw new Error("没有应用重新选择的视图")
  } finally {
    setup.renderer.keyInput.emit("keypress", key("\x03"))
    await running
    setup.renderer.destroy()
  }
}

const scenario = process.argv[2]
if (scenario === "invalid-model") await invalidModel()
else if (scenario === "no-views") await noViews()
else if (scenario === "throwing-create") await throwingCreate()
else if (scenario === "recover-prompt") await recoverPrompt()
else if (scenario === "recover-view-prompt") await recoverViewPrompt()
else throw new Error(`未知场景：${scenario}`)
