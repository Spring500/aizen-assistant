import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { computeFooterHeight } from "../../packages/tui-kit/footer-layout.ts"
import { setAizenTerminalTitle } from "../../packages/tui-kit/renderer.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

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

test("footer 高度为视口一半且保底最小可行高度", () => {
  // 目标 h/2 随视口增长、无上限；下限 9（压缩行后的最小可行高度）。
  expect(computeFooterHeight(10)).toBe(9)
  expect(computeFooterHeight(16)).toBe(9)
  expect(computeFooterHeight(20)).toBe(10)
  expect(computeFooterHeight(24)).toBe(12)
  expect(computeFooterHeight(40)).toBe(20)
  expect(computeFooterHeight(60)).toBe(30)
  expect(computeFooterHeight(0)).toBe(9)
})
