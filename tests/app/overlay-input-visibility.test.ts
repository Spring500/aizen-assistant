// 浮层开合不再切换输入区显隐：输入框保持渲染，浮层打开时被全屏背景覆盖，
// 关闭后无需经历可见性切换即可直接恢复——规避 OpenTUI 在 display None→Flex
// 切换后输入框区域不重绘的原生渲染问题。
import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { TextareaRenderable } from "@opentui/core"
import { runInteractiveApp } from "../../apps/tui/interactive-app.ts"
import { defaultAppPreferences } from "../../packages/core/app-preferences-store.ts"
import type { CoreCommand, CoreEvent, CorePort, CoreSnapshot } from "../../packages/core/types.ts"

const test = createDiagnosticTest({ timeoutMs: 15_000 })

function key(sequence: string): KeyEvent {
  const parsed = parseKeypress(sequence)
  if (!parsed) throw new Error("无法解析按键")
  return new KeyEvent(parsed)
}

const model = {
  providerId: "anthropic",
  modelId: "claude-sonnet-4-6",
  api: "anthropic-messages",
  thinkingLevel: "off",
  name: "Fixture Model",
  available: true,
}

class SessionCore implements CorePort {
  readonly commands: CoreCommand[] = []
  readonly listeners = new Set<(event: CoreEvent) => void>()
  readonly snapshot: CoreSnapshot = {
    cwd: "E:\\fixture",
    status: "idle",
    sessions: [],
    currentSessionId: "fixture-session",
    currentSessionName: "测试会话",
    currentModel: { ...model, thinkingLevel: "标准" },
    currentViewId: null,
    models: [{ ...model, thinkingLevel: "标准" }],
    modelConfig: {
      revision: "fixture",
      providers: [],
      apiChoices: ["anthropic-messages"],
      inputModalities: [{ value: "text", enabled: true }],
      outputModalities: [],
    },
    preferences: structuredClone(defaultAppPreferences),
    views: [
      { id: "view-a", name: "视图A", path: "E:\\fixture\\view-a", directory: "E:\\fixture\\view-a", valid: true },
    ],
    authProviders: [{ id: "anthropic", name: "Anthropic", configured: true, supportsApiKey: true }],
    transcript: [],
    transcriptRevision: 0,
    historyTurns: [],
    activeTools: [],
    streamingText: "",
    streamingThinking: "",
  }

  async dispatch(command: CoreCommand) {
    this.commands.push(command)
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

test("浮层开合不影响输入区显隐，关闭后输入框直接恢复", async () => {
  const setup = await createTestRenderer({
    width: 100,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 9,
    externalOutputMode: "capture-stdout",
  })
  const core = new SessionCore()
  const running = runInteractiveApp({
    cwd: core.snapshot.cwd,
    dataDirectory: "unused",
    testing: { renderer: setup.renderer, core },
  })
  try {
    const deadline = Date.now() + 3000
    while (!core.commands.some((item) => item.type === "load_preferences")) {
      if (Date.now() > deadline) throw new Error("应用启动超时")
      await Bun.sleep(10)
    }
    const editor = setup.renderer.root.getRenderable("editor") as TextareaRenderable | undefined
    if (!editor) throw new Error("找不到聊天输入框")

    // 执行 /views（逐字符输入 + 两次 Enter：补全后提交）
    for (const character of "/views") {
      setup.renderer.keyInput.emit("keypress", key(character))
      await Bun.sleep(2)
    }
    setup.renderer.keyInput.emit("keypress", key("\r"))
    await Bun.sleep(10)
    setup.renderer.keyInput.emit("keypress", key("\r"))
    await Bun.sleep(100)
    await setup.renderOnce()
    const menuFrame = setup.captureCharFrame()
    expect(menuFrame).toContain("管理视图")
    // 浮层打开时输入区保持可见（不切换显隐），由浮层背景覆盖
    expect(editor.visible).toBe(true)

    // 什么都不操作，直接 Esc 关闭
    setup.renderer.keyInput.emit("keypress", key("\x1b"))
    await Bun.sleep(100)
    await setup.renderOnce()
    const closedFrame = setup.captureCharFrame()
    expect(closedFrame).not.toContain("管理视图")
    // 关闭后输入框直接恢复显示（无需经历可见性切换）
    expect(editor.visible).toBe(true)
    expect(closedFrame).toContain("输入消息；Enter 发送")
  } finally {
    setup.renderer.keyInput.emit("keypress", key("\x03"))
    await Promise.race([running, Bun.sleep(1000)])
    setup.renderer.destroy()
  }
})
