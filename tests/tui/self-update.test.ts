import { describe, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { compareVersions, releaseTagFromUrl } from "../../apps/tui/self-update.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

describe("releaseTagFromUrl", () => {
  test("提取目标仓库的正式版本 tag", () => {
    expect(releaseTagFromUrl("https://github.com/Spring500/aizen-assistant/releases/tag/v0.3.0")).toBe("v0.3.0")
    expect(releaseTagFromUrl("https://github.com/Spring500/aizen-assistant/releases/tag/v0.3.1%2Bbuild.1")).toBe(
      "v0.3.1+build.1",
    )
  })

  test("拒绝错误仓库、路径和 tag", () => {
    expect(() => releaseTagFromUrl("https://github.com/other/repo/releases/tag/v0.3.0")).toThrow("最新版本地址格式异常")
    expect(() => releaseTagFromUrl("https://github.com/Spring500/aizen-assistant/releases/latest")).toThrow(
      "最新版本地址格式异常",
    )
    expect(() => releaseTagFromUrl("https://github.com/Spring500/aizen-assistant/releases/tag/0.3.0")).toThrow(
      "最新 release 的 tag 格式异常",
    )
  })
})

describe("compareVersions", () => {
  test("三段版本号比较", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
    expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0)
    expect(compareVersions("1.1.0", "1.0.9")).toBeGreaterThan(0)
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0)
    expect(compareVersions("0.9.0", "1.0.0")).toBeLessThan(0)
  })

  test("正式版大于预发布版", () => {
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0)
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0)
  })

  test("预发布标识符比较", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0)
    expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.2")).toBeLessThan(0)
    // 数字标识符按数值比较（2 < 10）
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0)
    // 标识符少的更小（beta < beta.1）
    expect(compareVersions("1.0.0-beta", "1.0.0-beta.1")).toBeLessThan(0)
  })
})
