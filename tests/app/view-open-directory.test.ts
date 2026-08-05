import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
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

async function setupApp(core: ViewsCore, root: string, openDirectory?: (path: string) => Promise<void>) {
  const setup = await createTestRenderer({
    width: 100,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 9,
    externalOutputMode: "capture-stdout",
  })
  const running = runInteractiveApp({
    cwd: root,
    dataDirectory: root,
    testing: { renderer: setup.renderer, core, ...(openDirectory ? { openDirectory } : {}) },
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
  const isAlive = async () => {
    const result = await Promise.race([
      running.then(
        () => "exited" as const,
        () => "rejected" as const,
      ),
      Bun.sleep(200).then(() => "alive" as const),
    ])
    return result === "alive"
  }
  const teardown = async () => {
    setup.renderer.keyInput.emit("keypress", key("\x03"))
    await running.catch(() => {})
    setup.renderer.destroy()
    await rm(root, { recursive: true, force: true })
  }
  return { setup, pressKey, waitFor, isAlive, teardown }
}

/** 从启动界面走到管理视图页面：会话设置 -> 管理视图 -> 标准视图。 */
async function enterViewPage(core: ViewsCore, root: string, openDirectory?: (path: string) => Promise<void>) {
  const app = await setupApp(core, root, openDirectory)
  await app.waitFor("会话设置 · 新建会话")
  // 会话设置 -> 管理视图（当前模型/当前视图/权限模式/管理模型/管理视图）
  for (let index = 0; index < 4; index++) await app.pressKey("\x1b[B")
  await app.pressKey("\r")
  await app.waitFor("管理视图（选择视图后进入操作菜单）")
  // 管理视图 -> 标准视图（刷新/创建视图模板/标准视图）
  for (let index = 0; index < 2; index++) await app.pressKey("\x1b[B")
  await app.pressKey("\r")
  await app.waitFor("管理视图 · 标准视图")
  return app
}

/**
 * 启动流程（chooseSession → 会话设置 → 管理视图）里的交互错误必须只提示、
 * 不能让整个应用退出。回归点：目录打开失败不应杀死应用。
 */
test("管理视图里打开目录失败只提示错误，应用保持存活", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-open-dir-"))
  const viewDir = join(root, "view")
  await mkdir(join(viewDir, "skills"), { recursive: true })
  const core = new ViewsCore(viewDir)
  const app = await enterViewPage(core, root, async () => {
    throw new Error("模拟打开目录失败")
  })
  try {
    // 页面行序：项目上下文边界/个人技能/名称/目录路径/编辑SYSTEM/编辑AGENTS/打开Skills
    for (let index = 0; index < 6; index++) await app.pressKey("\x1b[B")
    await app.pressKey("\r")
    expect(await app.isAlive()).toBe(true)
    const frame = app.setup.captureCharFrame()
    expect(frame).toContain("模拟打开目录失败")
  } finally {
    await app.teardown()
  }
})

test("视图配置项在页面内用左右键切换并实时写入", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-view-cycle-"))
  const viewDir = join(root, "view")
  await mkdir(join(viewDir, "skills"), { recursive: true })
  const core = new ViewsCore(viewDir)
  const app = await enterViewPage(core, root)
  try {
    await app.waitFor("项目上下文边界  [不读取]")
    // 选中第一项（项目上下文边界），按右循环：none -> pi-default -> git-root
    await app.pressKey("\x1b[C")
    await app.waitFor("项目上下文边界  [pi 默认]")
    await app.pressKey("\x1b[C")
    await app.waitFor("项目上下文边界  [git 根]")
    expect(JSON.parse(await readFile(join(viewDir, "config.json"), "utf8"))).toEqual({
      projectSources: "git-root",
      loadUserSkills: true,
    })
    // 移到第二项（个人技能）按右：加载 -> 不加载
    await app.pressKey("\x1b[B")
    await app.pressKey("\x1b[C")
    await app.waitFor("个人技能  [不加载]")
    expect(JSON.parse(await readFile(join(viewDir, "config.json"), "utf8"))).toEqual({
      projectSources: "git-root",
      loadUserSkills: false,
    })
    expect(await app.isAlive()).toBe(true)
  } finally {
    await app.teardown()
  }
})
