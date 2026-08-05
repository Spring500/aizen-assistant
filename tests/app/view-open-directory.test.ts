import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { runInteractiveApp } from "../../apps/tui/interactive-app.ts"
import { defaultAppPreferences } from "../../packages/core/app-preferences-store.ts"
import type { CoreCommand, CoreEvent, CorePort, CoreSnapshot } from "../../packages/core/types.ts"

const model = {
  providerId: "anthropic",
  modelId: "claude-sonnet-4-6",
  api: "anthropic-messages",
  thinkingLevel: "off",
  name: "Fixture Model",
  available: true,
}

function key(text: string): KeyEvent {
  const parsed = parseKeypress(text)
  if (!parsed) throw new Error(`无法解析按键：${JSON.stringify(text)}`)
  return new KeyEvent(parsed)
}

class ViewsCore implements CorePort {
  readonly listeners = new Set<(event: CoreEvent) => void>()
  snapshot: CoreSnapshot = {
    cwd: "E:\\fixture",
    status: "idle",
    sessions: [],
    models: [model],
    preferences: structuredClone(defaultAppPreferences),
    views: [],
    authProviders: [],
    transcript: [],
    activeTools: [],
    streamingText: "",
    streamingThinking: "",
  }
  constructor(directory: string) {
    this.snapshot.views = [{ id: "standard", name: "标准视图", path: directory, directory, valid: true }]
  }
  async dispatch(_command: CoreCommand) {
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

/**
 * 启动流程（chooseSession → createSession → 会话设置 → 管理视图）里的交互错误
 * 必须只提示、不能让整个应用退出。回归点：目录打开失败不应杀死应用。
 */
test("管理视图里打开目录失败只提示错误，应用保持存活", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-open-dir-"))
  const viewDir = join(root, "view")
  await mkdir(join(viewDir, "skills"), { recursive: true })
  const setup = await createTestRenderer({
    width: 100,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 9,
    externalOutputMode: "capture-stdout",
  })
  const core = new ViewsCore(viewDir)
  const running = runInteractiveApp({
    cwd: root,
    dataDirectory: root,
    testing: {
      renderer: setup.renderer,
      core,
      openDirectory: async () => {
        throw new Error("模拟打开目录失败")
      },
    },
  })
  const pressKey = async (text: string) => {
    setup.renderer.keyInput.emit("keypress", key(text))
    await Bun.sleep(10)
    await setup.renderOnce()
  }
  const waitFor = async (expected: string, timeoutMs = 1500) => {
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
  const alive = async () => {
    const result = await Promise.race([
      running.then(
        () => "exited" as const,
        () => "rejected" as const,
      ),
      Bun.sleep(200).then(() => "alive" as const),
    ])
    return result === "alive"
  }

  try {
    await waitFor("会话设置 · 新建会话")
    // 会话设置 -> 管理视图（当前模型/当前视图/权限模式/管理模型/管理视图）
    for (let index = 0; index < 4; index++) await pressKey("\x1b[B")
    await pressKey("\r")
    await waitFor("管理视图（选择视图后进入操作菜单）")
    // 管理视图 -> 标准视图（刷新/创建视图模板/标准视图）
    for (let index = 0; index < 2; index++) await pressKey("\x1b[B")
    await pressKey("\r")
    await waitFor("打开 Skills 目录")
    // 打开 Skills 目录（名称/目录路径/编辑SYSTEM/编辑AGENTS/打开Skills）
    for (let index = 0; index < 4; index++) await pressKey("\x1b[B")
    await pressKey("\r")

    expect(await alive()).toBe(true)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("模拟打开目录失败")
  } finally {
    setup.renderer.keyInput.emit("keypress", key("\x03"))
    await running.catch(() => {})
    setup.renderer.destroy()
    await rm(root, { recursive: true, force: true })
  }
})
