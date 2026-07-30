import { expect, test } from "bun:test"
import { setAizenTerminalTitle } from "../../packages/tui-kit/renderer.ts"

test("终端标题过滤控制字符并限制长度", () => {
  let actual = ""
  const renderer = {
    setTerminalTitle(title: string) {
      actual = title
    },
  }
  setAizenTerminalTitle(renderer as never, `${"会".repeat(130)}\n\u001b]0;恶意标题`)
  expect(Array.from(actual)).toHaveLength(120)
  expect(actual).not.toContain("\n")
  expect(actual).not.toContain("\u001b")
})
