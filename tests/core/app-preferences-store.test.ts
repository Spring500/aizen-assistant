import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
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
      },
      fold: { ...defaultAppPreferences.fold, assistantTurns: 5 },
    }
    await store.write(preferences)
    expect(await store.read()).toEqual(preferences)
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
