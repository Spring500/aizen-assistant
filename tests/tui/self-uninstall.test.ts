import { describe, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { filterInstalledPathLines } from "../../apps/tui/self-uninstall.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

describe("filterInstalledPathLines", () => {
  test("移除安装脚本写入的 PATH 行", () => {
    const lines = ['export PATH="$HOME/.aizen/bin:$PATH"', "export FOO=bar", "fish_add_path $HOME/.aizen/bin"]
    expect(filterInstalledPathLines(lines, "/home/user/.aizen/bin")).toEqual(["export FOO=bar"])
  })

  test("移除手写绝对路径的条目", () => {
    const lines = ['export PATH="/home/user/.aizen/bin:$PATH"', "export FOO=bar"]
    expect(filterInstalledPathLines(lines, "/home/user/.aizen/bin")).toEqual(["export FOO=bar"])
  })

  test("保留无关行", () => {
    const lines = ['export PATH="/usr/local/bin:$PATH"', "# comment", ""]
    expect(filterInstalledPathLines(lines, "/home/user/.aizen/bin")).toEqual(lines)
  })
})
