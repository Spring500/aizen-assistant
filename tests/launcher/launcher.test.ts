import { describe, expect } from "bun:test"
import { join } from "node:path"
import { resolveLaunchPlan, shouldInjectDataDir } from "../../apps/launcher/main.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

describe("launcher 启动计划", () => {
  test("按 current 解析真实可执行文件与固定数据目录（Windows）", () => {
    const plan = resolveLaunchPlan(join("C:\\Users\\me", ".aizen"), { current: "v0.2.0" }, "win32", ["update"])
    expect(plan.executable).toBe(join("C:\\Users\\me", ".aizen", "versions", "v0.2.0", "aizen-assistant.exe"))
    expect(plan.dataDirectory).toBe(join("C:\\Users\\me", ".aizen", "data"))
    expect(plan.args).toEqual(["update"])
  })

  test("按 current 解析真实可执行文件（POSIX）", () => {
    const plan = resolveLaunchPlan(join("/home/me", ".aizen"), { current: "v0.1.0" }, "linux", [])
    expect(plan.executable).toBe(join("/home/me", ".aizen", "versions", "v0.1.0", "aizen-assistant"))
    expect(plan.dataDirectory).toBe(join("/home/me", ".aizen", "data"))
  })

  test("current 缺失或非法时抛出错误", () => {
    expect(() => resolveLaunchPlan("/x", {}, "linux", [])).toThrow("缺少 current")
    expect(() => resolveLaunchPlan("/x", { current: "" }, "linux", [])).toThrow("缺少 current")
    expect(() => resolveLaunchPlan("/x", { current: 42 }, "linux", [])).toThrow("缺少 current")
  })
})

describe("launcher 数据目录注入", () => {
  test("交互模式注入 --data-dir", () => {
    expect(shouldInjectDataDir([])).toBe(true)
    expect(shouldInjectDataDir(["--data-dir", "/x"])).toBe(true)
  })

  test("update / uninstall 分发子命令不注入", () => {
    expect(shouldInjectDataDir(["update"])).toBe(false)
    expect(shouldInjectDataDir(["update", "--release-api", "url"])).toBe(false)
    expect(shouldInjectDataDir(["uninstall", "--yes"])).toBe(false)
  })
})
