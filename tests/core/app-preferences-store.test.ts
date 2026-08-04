import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AppPreferencesStore,
  defaultAppPreferences,
  parseAppPreferences,
} from "../../packages/core/app-preferences-store.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("应用偏好存储", () => {
  test("文件不存在时返回默认偏好并可持久化", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-preferences-"))
    directories.push(directory)
    const store = new AppPreferencesStore(join(directory, "preferences.json"))
    expect(await store.read()).toEqual(defaultAppPreferences)

    const preferences = {
      ...defaultAppPreferences,
      newSession: {
        model: { providerId: "p", modelId: "m", api: "a", thinkingLevel: "high" },
        viewId: "view",
        permissionMode: "hybrid" as const,
      },
      fold: { ...defaultAppPreferences.fold, thinkingExpanded: true },
    }
    await store.write(preferences)
    expect(await store.read()).toEqual(preferences)
  })

  test("迁移版本 1 的轮次折叠配置并兼容缺少 Agent 设置", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-preferences-"))
    directories.push(directory)
    const file = join(directory, "preferences.json")
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        newSession: { viewId: null },
        fold: { userTurns: 0, assistantTurns: 3, thinkingTurns: 0, toolGroupTurns: 2, toolDetailTurns: 0 },
      }),
    )
    const preferences = await new AppPreferencesStore(file).read()
    expect(preferences.version).toBe(2)
    expect(preferences.agents).toEqual({ sessionNaming: {} })
    expect(preferences.fold).toEqual({
      thinkingExpanded: true,
      toolGroupExpanded: false,
      toolDetailsExpanded: true,
    })
    await new AppPreferencesStore(file).write(preferences)
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 2, fold: preferences.fold })
  })

  test("会话命名偏好只保存供应商和模型标识", () => {
    expect(
      parseAppPreferences({
        ...defaultAppPreferences,
        agents: { sessionNaming: { model: { providerId: "provider", modelId: "title-model" } }, permissionReview: {} },
      }).agents,
    ).toEqual({
      sessionNaming: { model: { providerId: "provider", modelId: "title-model" } },
      permissionReview: {},
    })
    expect(() =>
      parseAppPreferences({
        ...defaultAppPreferences,
        agents: {
          sessionNaming: { model: { providerId: "provider", modelId: "title-model", api: "invalid" } },
          permissionReview: {},
        },
      }),
    ).toThrow("未知字段")
  })

  test("折叠设置只接受三个布尔开关", () => {
    expect(() =>
      parseAppPreferences({
        ...defaultAppPreferences,
        fold: { ...defaultAppPreferences.fold, thinkingExpanded: 1 },
      }),
    ).toThrow("fold.thinkingExpanded 必须是布尔值")
    expect(() =>
      parseAppPreferences({
        ...defaultAppPreferences,
        fold: { ...defaultAppPreferences.fold, userExpanded: true },
      }),
    ).toThrow("未知字段")
  })
})
