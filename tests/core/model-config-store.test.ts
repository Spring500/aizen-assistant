import { afterEach, describe, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelConfigStore } from "../../packages/core/model-config-store.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function makeStore(source?: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "aizen-model-config-"))
  directories.push(directory)
  const path = join(directory, "custom-providers.json")
  if (source !== undefined) await writeFile(path, JSON.stringify(source, null, 2))
  return { path, store: new ModelConfigStore(path) }
}

const provider = {
  id: "company",
  name: "公司网关",
  baseUrl: "https://example.com/v1",
  api: "openai-completions" as const,
  authHeader: true,
}

const model = {
  id: "model-a",
  name: "模型 A",
  input: ["text", "image"] as const,
  contextWindow: 128000,
  maxTokens: 16000,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 },
}

describe("模型配置存储", () => {
  test("新增供应商和模型并保留结构化数据", async () => {
    const { path, store } = await makeStore()
    let snapshot = await store.read()
    await store.upsertProvider(snapshot.revision, provider)
    snapshot = await store.read()
    await store.upsertModel(snapshot.revision, provider.id, { ...model, input: [...model.input] })

    snapshot = await store.read()
    expect(snapshot.providers[0]?.models[0]).toMatchObject(model)
    expect(snapshot.inputModalities).toContainEqual({
      value: "pdf",
      enabled: false,
      disabledReason: "当前 pi adapter 不支持",
    })
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      providers: { company: { models: [{ id: "model-a" }] } },
    })
  })

  test("保存并清除模型 Base URL 覆写", async () => {
    const { path, store } = await makeStore()
    let snapshot = await store.read()
    await store.upsertProvider(snapshot.revision, provider)
    snapshot = await store.read()
    await store.upsertModel(snapshot.revision, provider.id, {
      ...model,
      baseUrl: "https://example.com",
      input: [...model.input],
    })

    snapshot = await store.read()
    expect(snapshot.providers[0]?.models[0]?.baseUrl).toBe("https://example.com")
    expect(JSON.parse(await readFile(path, "utf8")).providers.company.models[0].baseUrl).toBe("https://example.com")

    await store.upsertModel(snapshot.revision, provider.id, { ...model, input: [...model.input] })
    expect(JSON.parse(await readFile(path, "utf8")).providers.company.models[0].baseUrl).toBeUndefined()
  })

  test("拒绝非法模型 Base URL", async () => {
    const { store } = await makeStore()
    let snapshot = await store.read()
    await store.upsertProvider(snapshot.revision, provider)
    snapshot = await store.read()
    await expect(
      store.upsertModel(snapshot.revision, provider.id, {
        ...model,
        baseUrl: "https://user:secret@example.com",
        input: [...model.input],
      }),
    ).rejects.toThrow("模型 Base URL 只能使用 HTTP/HTTPS")
  })

  test("保存模型自身思考档位并限制六个开启档位", async () => {
    const { path, store } = await makeStore()
    let snapshot = await store.read()
    await store.upsertProvider(snapshot.revision, provider)
    snapshot = await store.read()
    await store.upsertModel(snapshot.revision, provider.id, {
      ...model,
      input: [...model.input],
      thinking: {
        disableThinkingLevel: "关闭",
        thinkingLevels: ["A", "B", "C"],
        defaultThinkingLevel: "B",
      },
    })

    const saved = JSON.parse(await readFile(path, "utf8"))
    expect(saved.providers.company.models[0]).toMatchObject({
      disableThinkingLevel: "关闭",
      thinkingLevels: ["A", "B", "C"],
      defaultThinkingLevel: "B",
    })
    expect((await store.read()).providers[0]?.models[0]?.thinking).toEqual({
      disableThinkingLevel: "关闭",
      thinkingLevels: ["A", "B", "C"],
      defaultThinkingLevel: "B",
    })

    snapshot = await store.read()
    await expect(
      store.upsertModel(snapshot.revision, provider.id, {
        ...model,
        input: [...model.input],
        thinking: {
          thinkingLevels: ["A", "B", "C", "D", "E", "F", "G"],
          defaultThinkingLevel: "A",
        },
      }),
    ).rejects.toThrow("最多支持六个档位")
  })

  test("忽略废弃字段并严格校验Aizen思考字段", async () => {
    const { store } = await makeStore({
      providers: {
        company: {
          ...provider,
          models: [
            {
              ...model,
              reasoning: true,
              thinkingLevelMap: { low: "旧档位" },
              aizenThinkingDefault: "旧档位",
            },
          ],
        },
      },
    })
    expect((await store.read()).providers[0]?.models[0]?.thinking).toBeUndefined()

    const snapshot = await store.read()
    await expect(
      store.upsertModel(snapshot.revision, provider.id, {
        ...model,
        input: [...model.input],
        thinking: {
          disableThinkingLevel: " A ",
          thinkingLevels: ["A"],
          defaultThinkingLevel: "A",
        },
      }),
    ).rejects.toThrow("不能重复")
    await expect(
      store.upsertModel(snapshot.revision, provider.id, {
        ...model,
        input: [...model.input],
        thinking: { thinkingLevels: ["A\nB"], defaultThinkingLevel: "A\nB" },
      }),
    ).rejects.toThrow("控制字符")
  })

  test("创建模式拒绝重复 ID", async () => {
    const { store } = await makeStore()
    let snapshot = await store.read()
    await store.upsertProvider(snapshot.revision, provider, "create")
    snapshot = await store.read()
    await expect(store.upsertProvider(snapshot.revision, provider, "create")).rejects.toThrow("供应商 ID 已存在")
    await store.upsertModel(snapshot.revision, provider.id, { ...model, input: [...model.input] }, "create")
    snapshot = await store.read()
    await expect(
      store.upsertModel(snapshot.revision, provider.id, { ...model, input: [...model.input] }, "create"),
    ).rejects.toThrow("模型 ID 已存在")
  })

  test("拒绝过期修订覆盖外部修改", async () => {
    const { path, store } = await makeStore()
    const snapshot = await store.read()
    await writeFile(path, JSON.stringify({ providers: { external: {} } }))
    await expect(store.upsertProvider(snapshot.revision, provider)).rejects.toThrow("已被其他程序修改")
  })

  test("拒绝非法枚举和跨字段数值", async () => {
    const { store } = await makeStore()
    const snapshot = await store.read()
    await expect(
      store.upsertProvider(snapshot.revision, { ...provider, api: "invalid" as typeof provider.api }),
    ).rejects.toThrow("不是支持的 API")

    await store.upsertProvider(snapshot.revision, provider)
    const next = await store.read()
    await expect(
      store.upsertModel(next.revision, provider.id, {
        ...model,
        input: ["text"],
        contextWindow: 100,
        maxTokens: 101,
      }),
    ).rejects.toThrow("不能超过上下文窗口")
  })

  test("无法安全编辑的供应商和模型以只读状态加载", async () => {
    const { store } = await makeStore({
      providers: {
        anthropic: { baseUrl: "https://proxy.example.com" },
        custom: {
          baseUrl: "https://example.com/v1",
          api: "openai-completions",
          models: [{ id: "future", input: ["text", "audio"] }],
        },
      },
    })
    const snapshot = await store.read()
    expect(snapshot.providers.find((item) => item.id === "anthropic")?.editable).toBe(false)
    expect(snapshot.providers.find((item) => item.id === "custom")?.models[0]).toMatchObject({
      editable: false,
      readonlyReason: "包含当前 adapter 不支持的输入模态：audio",
    })
  })
})
