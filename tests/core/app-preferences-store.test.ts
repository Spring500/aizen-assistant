import { afterEach, describe, expect } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AppPreferencesStore,
  defaultAppPreferences,
  parseAppPreferences,
} from "../../packages/core/app-preferences-store.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

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
        model: { providerId: "p", modelId: "m", thinkingLevel: "high" },
        viewId: "view",
        permissionPreset: "plan" as const,
        permissionReviewMode: "autoDeny" as const,
      },
      fold: { ...defaultAppPreferences.fold, thinkingExpanded: true },
    }
    await store.write(preferences)
    expect(await store.read()).toEqual(preferences)
  })

  test("逐字段保留合法偏好并为无效和废弃字段使用默认值", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-preferences-"))
    directories.push(directory)
    const file = join(directory, "preferences.json")
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        newSession: {
          viewId: "review",
          model: { providerId: "p", modelId: "m" },
        },
        agents: {
          sessionNaming: { model: { providerId: "title", modelId: "model" } },
          permissionReview: { model: { providerId: "review" } },
        },
        fold: {
          userTurns: 0,
          thinkingExpanded: true,
          toolGroupExpanded: "yes",
        },
      }),
    )
    const store = new AppPreferencesStore(file)
    expect(await store.read()).toEqual({
      newSession: {
        viewId: "review",
        permissionPreset: "edit",
        permissionReviewMode: "manual",
        model: { providerId: "p", modelId: "m" },
      },
      agents: {
        sessionNaming: { model: { providerId: "title", modelId: "model" } },
        permissionReview: {},
      },
      fold: {
        thinkingExpanded: true,
        toolGroupExpanded: false,
        toolDetailsExpanded: false,
      },
    })
    expect(store.takeWarnings()).toEqual([
      "preferences.json.version 是未知字段，已忽略",
      "newSession.permissionPreset 缺失，已使用默认值",
      "newSession.permissionReviewMode 缺失，已使用默认值",
      "agents.permissionReview.model.modelId 必须是字符串，已使用默认值",
      "fold.userTurns 是未知字段，已忽略",
      "fold.toolGroupExpanded 必须是布尔值，已使用默认值",
      "fold.toolDetailsExpanded 缺失，已使用默认值",
    ])
    expect(store.takeWarnings()).toEqual([])
  })

  test("非法 JSON 和非对象根节点使用全部默认偏好并报告原因", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-preferences-"))
    directories.push(directory)
    const file = join(directory, "preferences.json")
    const store = new AppPreferencesStore(file)
    await writeFile(file, "{")
    expect(await store.read()).toEqual(defaultAppPreferences)
    expect(store.takeWarnings()[0]).toContain("preferences.json 不是有效 JSON，已使用全部默认偏好")

    await writeFile(file, "[]")
    expect(await store.read()).toEqual(defaultAppPreferences)
    expect(store.takeWarnings()).toEqual(["preferences.json 必须是对象，已使用默认值"])
  })

  test("会话命名偏好保存模型引用并兼容忽略旧 api 字段", () => {
    expect(
      parseAppPreferences({
        ...defaultAppPreferences,
        agents: { sessionNaming: { model: { providerId: "provider", modelId: "title-model" } }, permissionReview: {} },
      }).agents,
    ).toEqual({
      sessionNaming: { model: { providerId: "provider", modelId: "title-model" } },
      permissionReview: {},
    })
    // 旧数据可能带 api 字段（属于模型定义层），解析时兼容忽略，不影响引用内容
    expect(
      parseAppPreferences({
        ...defaultAppPreferences,
        agents: {
          sessionNaming: {
            model: { providerId: "provider", modelId: "title-model", api: "invalid", thinkingLevel: "high" },
          },
          permissionReview: {},
        },
      }).agents,
    ).toEqual({
      sessionNaming: { model: { providerId: "provider", modelId: "title-model", thinkingLevel: "high" } },
      permissionReview: {},
    })
  })

  test("写入时严格拒绝非法折叠设置", () => {
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
