import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
      fold: { ...defaultAppPreferences.fold, assistantTurns: 5 },
    }
    await store.write(preferences)
    expect(await store.read()).toEqual(preferences)
  })

  test("兼容缺少 Agent 设置的既有偏好", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-preferences-"))
    directories.push(directory)
    const file = join(directory, "preferences.json")
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        newSession: { viewId: null },
        fold: defaultAppPreferences.fold,
      }),
    )
    expect((await new AppPreferencesStore(file).read()).agents).toEqual({ sessionNaming: {} })
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

  test("工具详情范围不得超过工具组", () => {
    expect(() =>
      parseAppPreferences({
        ...defaultAppPreferences,
        fold: { ...defaultAppPreferences.fold, toolGroupTurns: 2, toolDetailTurns: 3 },
      }),
    ).toThrow("工具详情展开轮次不能大于工具组")
    expect(() =>
      parseAppPreferences({
        ...defaultAppPreferences,
        fold: { ...defaultAppPreferences.fold, toolGroupTurns: 2, toolDetailTurns: 0 },
      }),
    ).toThrow("工具详情展开轮次不能大于工具组")
  })
})
