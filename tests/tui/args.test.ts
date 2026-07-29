import { describe, expect, test } from "bun:test"
import { parseArguments } from "../../apps/tui/args.ts"

describe("TUI 参数", () => {
  test("交互模式接受数据目录", () => {
    expect(parseArguments(["--data-dir", ".aizen/dev-data"])).toEqual({
      mode: "interactive",
      dataDirectory: ".aizen/dev-data",
    })
  })

  test("交互模式拒绝其它参数", () => {
    expect(() => parseArguments(["--unknown"])).toThrow("TUI 只接受 --data-dir")
    expect(() => parseArguments(["--plain"])).toThrow("TUI 只接受 --data-dir")
  })
})
