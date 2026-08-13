export type BashNode = {
  text: string
  /** 该节点是否来自管道上游（不可见代码来源判定用）。 */
  fromPipe: boolean
}

export type BashParseResult =
  | { kind: "nodes"; nodes: BashNode[] }
  | { kind: "unknown" }
  | { kind: "structural-deny"; reason: string }

/** 解释器集合：从不可见来源取码时判 unknown，不询问分类器。 */
const interpreterNames = new Set(["bash", "sh", "zsh", "python", "python3", "node", "perl", "ruby"])

/** 迁移自旧 bash 验证器：变量展开、命令替换、控制结构等不可靠语法。 */
const unsupportedSyntax =
  /`|\$\(|\$\{|\$[A-Za-z_][A-Za-z0-9_]*|<<|\b(eval|function|for|while|until|case|select)\b|\n\s*(for|while|until|case)\b/

/** 结构性拒绝：函数/alias 定义、eval、source。破坏系统判断能力本身，直接拒绝无放行入口。 */
const structuralDenyPatterns: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\beval\b/,
    reason: "eval executes data as code, so its behavior cannot be reviewed before it runs; write the command directly instead of wrapping it in eval",
  },
  {
    pattern: /(?:^|[\s;&|])(?:source|\.)\s+\S+/,
    reason: "source executes the contents of an external file, which is invisible at review time; write the commands to run directly",
  },
  {
    pattern: /(?:^|\n)\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{/,
    reason:
      "defining a shell function would make later commands with the same name misclassified; run the command directly instead of defining a function",
  },
  {
    pattern: /(?:^|\n)\s*alias\s+[A-Za-z_][A-Za-z0-9_]*\s*=/,
    reason:
      "defining an alias would make later commands with the same name misclassified; run the command directly instead of defining an alias",
  },
  {
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: "this command spawns infinitely many copies of itself and exhausts system resources; do not run it",
  },
]

/** 将命令 token 化；引号或转义未闭合时返回 undefined。 */
function tokenize(command: string): string[] | undefined {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  for (const character of command.trim()) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === "\\" && quote !== "'") escaped = true
    else if (quote) {
      if (character === quote) quote = undefined
      else current += character
    } else if (character === "'" || character === '"') quote = character
    else if (/\s/.test(character)) {
      if (current) tokens.push(current)
      current = ""
    } else current += character
  }
  if (quote || escaped) return undefined
  if (current) tokens.push(current)
  return tokens
}

/** 按管道、&&、||、;、换行拆分节点；单字符 &、(、) 视为不支持的控制语法。 */
function splitNodes(command: string): Array<{ text: string; fromPipe: boolean }> | undefined {
  const result: Array<{ text: string; fromPipe: boolean }> = []
  let current = ""
  let fromPipe = false
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = 0; index < command.length; index++) {
    const character = command[index] ?? ""
    const next = command[index + 1] ?? ""
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      current += character
      escaped = true
      continue
    }
    if (quote) {
      current += character
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      current += character
      continue
    }
    if (character === "|") {
      if (next === "|") index++
      if (current.trim()) result.push({ text: current.trim(), fromPipe })
      current = ""
      fromPipe = true
      continue
    }
    if (character === ";" || character === "\n" || (character === "&" && next === "&")) {
      if (character === "&" && next === "&") index++
      if (current.trim()) result.push({ text: current.trim(), fromPipe })
      current = ""
      fromPipe = false
      continue
    }
    current += character
  }
  if (quote || escaped) return undefined
  if (current.trim()) result.push({ text: current.trim(), fromPipe })
  return result
}

/** 单字符控制语法（<、>、裸 &、(、)）超出首期可靠子集。 */
function hasUnsupportedControlSyntax(command: string): boolean {
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = 0; index < command.length; index++) {
    const character = command[index] ?? ""
    const next = command[index + 1] ?? ""
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === ">" || character === "<") return true
    if (character === "&" && next !== "&" && command[index - 1] !== "&") return true
    if (character === "(" || character === ")") return true
  }
  return false
}

/** 解释器从不可见来源取码：无脚本文件参数、无 -c/-e 字面脚本，且来自管道或存在输入重定向。 */
function invisibleCode(node: { text: string; fromPipe: boolean }): boolean {
  const tokens = tokenize(node.text)
  if (!tokens || tokens.length === 0) return false
  const executable = tokens[0]?.split(/[\\/]/).at(-1)?.toLowerCase()
  if (!executable || !interpreterNames.has(executable)) return false
  const rest = tokens.slice(1)
  const hasVisibleSource =
    rest.some((token) => !token.startsWith("-") && token !== "&") || rest.includes("-c") || rest.includes("-e")
  if (hasVisibleSource) return false
  const hasInputRedirect = /<\s*[^<\s]/.test(node.text)
  return node.fromPipe || hasInputRedirect
}

/** 解析一条 bash 命令：输出节点序列 / unknown / 结构性拒绝。 */
export function parseBash(command: string): BashParseResult {
  const structural = structuralDenyPatterns.find((item) => item.pattern.test(command))
  if (structural) return { kind: "structural-deny", reason: structural.reason }
  if (!command.trim()) return { kind: "unknown" }
  if (unsupportedSyntax.test(command) || hasUnsupportedControlSyntax(command)) return { kind: "unknown" }
  const nodes = splitNodes(command)
  if (!nodes || nodes.length === 0) return { kind: "unknown" }
  if (nodes.some(invisibleCode)) return { kind: "unknown" }
  return { kind: "nodes", nodes }
}
