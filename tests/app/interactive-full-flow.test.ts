import { expect, test } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { runInteractiveApp } from "../../apps/tui/interactive-app.ts"
import type { CoreCommand, CoreEvent, CorePort, CoreSnapshot } from "../../packages/core/types.ts"

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

async function pressEnter(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(10)
  await setup.renderOnce()
}

test("完整 TUI 链路：创建失败错误不会被选择无视图的 Enter 立即关闭", async () => {
  const setup = await createTestRenderer({
    width: 100,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 9,
    externalOutputMode: "capture-stdout",
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
    expect(setup.captureCharFrame()).toContain("选择供应商")

    await pressEnter(setup)
    expect(setup.captureCharFrame()).toContain("选择模型")
    await pressEnter(setup)
    expect(setup.captureCharFrame()).toContain("选择视图")
    expect(setup.captureCharFrame()).toContain("无视图")

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
    setup.renderer.destroy()
  }
})
