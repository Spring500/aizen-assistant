import { describe, expect, test } from "bun:test"
import { parseArguments } from "../../apps/tui/args.ts"

describe("TUI 参数", () => {
  test("交互模式接受数据目录", () => {
    expect(parseArguments(["--data-dir", ".aizen/dev-data"], {})).toEqual({
      mode: "interactive",
      dataDirectory: ".aizen/dev-data",
    })
  })

  test("交互模式拒绝其它参数", () => {
    expect(() => parseArguments(["--unknown"], {})).toThrow("交互模式只接受 --data-dir")
  })

  test("单次模式拒绝数据目录", () => {
    expect(() =>
      parseArguments(
        ["--plain", "--data-dir", "data", "--base-url", "http://localhost", "--api-key", "key", "--message", "hi"],
        {},
      ),
    ).toThrow("--plain 不接受 --data-dir")
  })
})
