import { describe, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { compareVersions } from "../../apps/tui/self-update.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

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
