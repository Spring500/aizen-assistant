import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { prepareMarkdownForTerminal } from "../../packages/tui-kit/markdown.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

test("终端 Markdown 把行内和块公式转换为 Unicode 近似形式", () => {
  const source = [
    "行内公式 $E = mc^2$。",
    "",
    "$$",
    "\\sum_{i=0}^{n} x_i",
    "$$",
    "",
    "$$ \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} $$",
  ].join("\n")

  expect(prepareMarkdownForTerminal(source)).toBe(
    [
      "行内公式 `E = mc²`。",
      "",
      "```aizen-math",
      "∑ᵢ₌₀ⁿ xᵢ",
      "```",
      "",
      "```aizen-math",
      "(−b ± √(b² − 4ac))/(2a)",
      "```",
    ].join("\n"),
  )
})

test("终端 Markdown 不改写代码跨度和围栏代码中的美元符号", () => {
  const source = ["`$inline$`", "", "```ts", 'const price = "$42"', "```"].join("\n")
  expect(prepareMarkdownForTerminal(source)).toBe(source)
})

test("未闭合块公式保留原始内容", () => {
  expect(prepareMarkdownForTerminal("$$\n\\alpha + \\beta")).toBe("$$\n\\alpha + \\beta")
})
