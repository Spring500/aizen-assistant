import { describe, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { parseArguments, usage } from "../../apps/tui/args.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

describe("TUI 参数", () => {
  test("接受数据目录参数", () => {
    expect(parseArguments(["--data-dir", ".aizen"])).toEqual({
      mode: "interactive",
      dataDirectory: ".aizen",
    })
  })

  test("没有参数时使用默认数据目录", () => {
    expect(parseArguments([])).toEqual({ mode: "interactive" })
  })

  test("拒绝未知、重复和缺少值的参数", () => {
    expect(() => parseArguments(["--unknown"])).toThrow("未知的 TUI 参数")
    expect(() => parseArguments(["--data-dir"])).toThrow("必须提供目录")
    expect(() => parseArguments(["--data-dir", "one", "--data-dir", "two"])).toThrow("不能重复指定")
  })

  test("用法包含所有可用启动参数", () => {
    expect(usage()).toContain("--data-dir <目录>")
  })
})
