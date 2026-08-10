import { afterEach, expect } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import { startMockServer } from "../../tests/utils/mock-server.ts"
import { AppPreferencesStore } from "../../packages/core/app-preferences-store.ts"
import { ModelConfigStore } from "../../packages/core/model-config-store.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { ViewStore } from "../../packages/core/view-store.ts"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDiagnosticTest } from "../../tests/utils/diagnostic-test.ts"
import { availableMockSuites, parseMockArguments, prepareMockData } from "./run-mock.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("解析套件名与保留运行数据参数", () => {
  expect(parseMockArguments([])).toEqual({ suite: "default", keep: false })
  expect(parseMockArguments(["review", "--keep"])).toEqual({ suite: "review", keep: true })
  expect(() => parseMockArguments(["one", "two"])).toThrow("只能指定一个套件名")
})

test("重建或保留 mock-data 运行实例", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-mock-launcher-"))
  directories.push(root)
  const templates = join(root, "templates")
  const source = join(templates, "default")
  await Bun.write(join(source, "config.json"), '{"version": 1}\n')
  expect(await availableMockSuites(templates)).toEqual(["default"])
  const data = await prepareMockData({ root, templatesDirectory: templates, suite: "default", keep: false })
  expect(await readFile(join(data, "config.json"), "utf8")).toContain('"version": 1')
  await writeFile(join(data, "config.json"), '{"changed": true}\n')
  await prepareMockData({ root, templatesDirectory: templates, suite: "default", keep: true })
  expect(await readFile(join(data, "config.json"), "utf8")).toContain('"changed": true')
  await prepareMockData({ root, templatesDirectory: templates, suite: "default", keep: false })
  expect(await readFile(join(data, "config.json"), "utf8")).toContain('"version": 1')
})

test("默认模板预配置可用模型、子 Agent 和视图", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-mock-template-"))
  directories.push(root)
  const templates = join(process.cwd(), "tests", "fixtures", "mock-data-templates")
  const data = await prepareMockData({ root, templatesDirectory: templates, suite: "default", keep: false })
  const preferences = await new AppPreferencesStore(join(data, "preferences.json")).read()
  expect(preferences.newSession).toMatchObject({
    model: { providerId: "mock-anthropic", modelId: "mock-dsl" },
    viewId: "mock-default",
    permissionReviewMode: "aiReview",
  })
  expect(preferences.agents).toEqual({
    sessionNaming: { model: { providerId: "mock-anthropic", modelId: "mock-naming" } },
    permissionReview: { model: { providerId: "mock-anthropic", modelId: "mock-review" } },
  })
  expect(await new ModelConfigStore(join(data, "custom-providers.json")).read()).toMatchObject({
    providers: expect.arrayContaining([
      expect.objectContaining({ id: "mock-anthropic" }),
      expect.objectContaining({ id: "mock-openai" }),
    ]),
  })
  const runtime = await PiSessionRuntime.create({
    authPath: join(data, "auth.json"),
    customProvidersPath: join(data, "custom-providers.json"),
  })
  try {
    expect(
      (await runtime.listModels())
        .filter((model) => model.providerId.startsWith("mock-"))
        .every((model) => model.available),
    ).toBe(true)
  } finally {
    await runtime.dispose()
  }
  expect(await new ViewStore(join(data, "views.json")).list()).toContainEqual(
    expect.objectContaining({ id: "mock-default", valid: true }),
  )
})

test("默认套件完成主回复、命名和 AI 审核", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-mock-default-flow-"))
  directories.push(root)
  const templates = join(process.cwd(), "tests", "fixtures", "mock-data-templates")
  const data = await prepareMockData({ root, templatesDirectory: templates, suite: "default", keep: false })
  const mock = await startMockServer({ port: 0 })
  try {
    const providersPath = join(data, "custom-providers.json")
    const providers = JSON.parse(await readFile(providersPath, "utf8")) as {
      providers: Record<string, { baseUrl: string }>
    }
    for (const provider of Object.values(providers.providers))
      provider.baseUrl = mock.url + (provider.baseUrl.endsWith("/v1") ? "/v1" : "")
    await writeFile(providersPath, `${JSON.stringify(providers, null, 2)}\n`)
    const preferencesStore = new AppPreferencesStore(join(data, "preferences.json"))
    const pi = await PiSessionRuntime.create({ authPath: join(data, "auth.json"), customProvidersPath: providersPath })
    const core = new AizenCore({
      cwd: root,
      store: new SessionStore(join(data, "sessions")),
      pi,
      preferencesStore,
      views: new ViewStore(join(data, "views.json")),
    })
    try {
      expect(await core.dispatch({ type: "load_preferences" })).toEqual({ ok: true })
      const preferences = core.getSnapshot().preferences
      if (!preferences.newSession.model) throw new Error("默认套件未配置主模型")
      expect(
        await core.dispatch({
          type: "create_session",
          model: preferences.newSession.model,
          viewId: preferences.newSession.viewId,
          permissionMode: preferences.newSession.permissionMode ?? "hybrid",
          ...(preferences.newSession.permissionPreset === undefined
            ? {}
            : { permissionPreset: preferences.newSession.permissionPreset }),
          ...(preferences.newSession.permissionReviewMode === undefined
            ? {}
            : { permissionReviewMode: preferences.newSession.permissionReviewMode }),
        }),
      ).toEqual({ ok: true })
      expect(
        await core.dispatch({
          type: "send_prompt",
          text: "text 主回复\nbash T1 [拒绝] 发布包 | npm publish",
        }),
      ).toEqual({ ok: true })
      for (let attempt = 0; attempt < 50 && !core.getSnapshot().currentSessionName; attempt++) await Bun.sleep(10)
      expect(core.getSnapshot().currentSessionName).toContain("text 主回复")
      const requests = await mock.requests()
      expect(requests.map((request) => request.body.model)).toContain("mock-dsl")
      expect(requests.map((request) => request.body.model)).toContain("mock-naming")
      expect(requests.map((request) => request.body.model)).toContain("mock-review")
      expect(
        core
          .getSnapshot()
          .transcript.some(
            (entry) => entry.type === "message" && entry.message.role === "tool" && entry.message.isError,
          ),
      ).toBe(true)
    } finally {
      await core.dispose()
    }
  } finally {
    mock.stop()
  }
})

test("未知套件列出可用名称", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-mock-launcher-"))
  directories.push(root)
  const templates = join(root, "templates")
  await Bun.write(join(templates, "default", ".keep"), "")
  await expect(prepareMockData({ root, templatesDirectory: templates, suite: "missing", keep: false })).rejects.toThrow(
    "自举套件不存在：missing；可用套件：default",
  )
})
