import { describe, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { parseArguments, usage } from "../../apps/tui/args.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

describe("TUI 参数", () => {
  test("接受数据目录参数", () => {
    expect(parseArguments(["--data-dir", ".aizen"])).toEqual({
      command: "interactive",
      dataDirectory: ".aizen",
    })
  })

  test("没有参数时使用默认数据目录", () => {
    expect(parseArguments([])).toEqual({ command: "interactive" })
  })

  test("解析 update 与 uninstall 子命令", () => {
    expect(parseArguments(["update"])).toEqual({ command: "update" })
    expect(parseArguments(["update", "--release-api", "http://localhost:18081"])).toEqual({
      command: "update",
      releaseApi: "http://localhost:18081",
    })
    expect(parseArguments(["uninstall"])).toEqual({ command: "uninstall", yes: false, skipPath: false })
    expect(parseArguments(["uninstall", "--yes"])).toEqual({ command: "uninstall", yes: true, skipPath: false })
    expect(parseArguments(["uninstall", "--yes", "--skip-path"])).toEqual({
      command: "uninstall",
      yes: true,
      skipPath: true,
    })
  })

  test("拒绝未知、重复和缺少值的参数", () => {
    expect(() => parseArguments(["--unknown"])).toThrow("未知的 TUI 参数")
    expect(() => parseArguments(["--data-dir"])).toThrow("必须提供目录")
    expect(() => parseArguments(["--data-dir", "one", "--data-dir", "two"])).toThrow("不能重复指定")
    expect(() => parseArguments(["update", "--force"])).toThrow("update 只接受 --release-api 参数")
    expect(() => parseArguments(["uninstall", "--bad"])).toThrow("uninstall 只接受 --yes 与 --skip-path 参数")
    expect(() => parseArguments(["uninstall", "--yes", "--yes"])).toThrow("uninstall 的 --yes 不能重复指定")
    expect(() => parseArguments(["uninstall", "--skip-path", "--skip-path"])).toThrow(
      "uninstall 的 --skip-path 不能重复指定",
    )
  })

  test("用法包含所有可用启动参数与子命令", () => {
    expect(usage()).toContain("--data-dir <目录>")
    expect(usage()).toContain("aizen-assistant update")
    expect(usage()).toContain("aizen-assistant uninstall")
  })
})
