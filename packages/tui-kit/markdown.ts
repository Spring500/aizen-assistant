import type { Token, Tokens } from "marked"
import { replace as latexToUnicode } from "unicodeit"

const fencedCodePattern = /^\s*(`{3,}|~{3,})/
const blockFormulaPattern = /^\s*\$\$\s*(.*?)\s*\$\$\s*$/

function replaceLatexCommands(source: string): string {
  let result = source
  let previous = ""
  while (result !== previous) {
    previous = result
    result = result
      .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)")
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)")
  }
  return result
}

function formulaText(source: string): string {
  const trimmed = source.trim()
  if (!trimmed) return ""
  try {
    return latexToUnicode(replaceLatexCommands(trimmed))
  } catch {
    return trimmed
  }
}

function replaceInlineFormulas(line: string): string {
  let result = ""
  let index = 0
  let codeDelimiter = 0
  while (index < line.length) {
    if (line[index] === "`") {
      let end = index
      while (line[end] === "`") end += 1
      const length = end - index
      codeDelimiter = codeDelimiter === 0 ? length : codeDelimiter === length ? 0 : codeDelimiter
      result += line.slice(index, end)
      index = end
      continue
    }
    if (codeDelimiter === 0 && line[index] === "$" && line[index - 1] !== "\\" && line[index + 1] !== "$") {
      let end = index + 1
      while (end < line.length) {
        if (line[end] === "$" && line[end - 1] !== "\\" && line[end + 1] !== "$") break
        end += 1
      }
      if (end < line.length) {
        const formula = formulaText(line.slice(index + 1, end))
        result += formula ? `\`${formula.replace(/`/g, "\\`")}\`` : line.slice(index, end + 1)
        index = end + 1
        continue
      }
    }
    result += line[index]
    index += 1
  }
  return result
}

/** 将 Markdown 数学公式转换为适合终端显示的 Unicode 近似形式。 */
export function prepareMarkdownForTerminal(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const output: string[] = []
  let fence: string | undefined
  let blockFormula: string[] | undefined

  for (const line of lines) {
    if (blockFormula) {
      const closing = /^(.*?)\$\$\s*$/.exec(line)
      if (closing) {
        blockFormula.push(closing[1] ?? "")
        output.push("```aizen-math", formulaText(blockFormula.join("\n")), "```")
        blockFormula = undefined
      } else blockFormula.push(line)
      continue
    }

    const fenceMatch = fencedCodePattern.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? ""
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      output.push(line)
      continue
    }
    if (fence) {
      output.push(line)
      continue
    }

    const singleLineFormula = blockFormulaPattern.exec(line)
    if (singleLineFormula) {
      output.push("```aizen-math", formulaText(singleLineFormula[1] ?? ""), "```")
      continue
    }
    const opening = /^\s*\$\$\s*(.*)$/.exec(line)
    if (opening) {
      blockFormula = [opening[1] ?? ""]
      continue
    }
    output.push(replaceInlineFormulas(line))
  }

  if (blockFormula) output.push(`$$${blockFormula[0] ? ` ${blockFormula[0]}` : ""}`, ...blockFormula.slice(1))
  return output.join("\n")
}

/** 判断代码块 Token 是否是终端公式块。 */
export function isMathCodeBlock(token: Token): token is Tokens.Code {
  return token.type === "code" && token.lang === "aizen-math"
}
