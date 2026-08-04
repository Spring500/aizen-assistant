import { isAbsolute, relative, resolve } from "node:path"
import type { JsonValue } from "../../session-format.ts"
import type {
  PermissionCoverageGap,
  PermissionFinding,
  ToolAssessment,
  ToolPermissionDecision,
  ToolPermissionRequest,
  ToolPermissionValidator,
} from "../types.ts"

const safeCommands = new Set([
  "cat",
  "cut",
  "echo",
  "false",
  "grep",
  "head",
  "id",
  "ls",
  "nl",
  "pwd",
  "rg",
  "stat",
  "tail",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
])
const safeGitCommands = new Set(["status", "diff", "log", "show"])
const humanCommands = new Set([
  "chmod",
  "chown",
  "dd",
  "eval",
  "fdisk",
  "mkfs",
  "mount",
  "passwd",
  "shutdown",
  "sudo",
  "systemctl",
  "umount",
])
const networkCommands = new Set(["curl", "wget"])
const remoteMutationCommands = new Set(["push", "fetch", "pull", "clone"])
const packageCommands = new Set(["bun", "npm", "pnpm", "yarn", "cargo", "pip", "pip3"])
const unsupportedSyntax =
  /`|\$\(|\$\{|\$[A-Za-z_][A-Za-z0-9_]*|<<|\b(eval|function|for|while|until|case|select)\b|\n\s*(for|while|until|case)\b/
const destructiveRoot =
  /\brm\b[^\n]*(?:-\w*r\w*f|-\w*f\w*r|--recursive)[^\n]*(?:\s\/\s*$|\s\/[\s;&|]|\s[A-Za-z]:[\\/]\s*$)/i
const forkBomb = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/

function object(value: JsonValue): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function tokenize(command: string): string[] | undefined {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  for (const character of command) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      current += character
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
    if (/\s/.test(character)) {
      if (current) tokens.push(current)
      current = ""
      continue
    }
    current += character
  }
  if (quote || escaped) return undefined
  if (current) tokens.push(current)
  return tokens
}

function splitCommands(command: string): string[] | undefined {
  const result: string[] = []
  let current = ""
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
    if (character === ";" || character === "\n" || character === "|" || (character === "&" && next === "&")) {
      if (character === "|" && next === "|") index++
      if (character === "&" && next === "&") index++
      if (current.trim()) result.push(current.trim())
      current = ""
      continue
    }
    current += character
  }
  if (quote || escaped) return undefined
  if (current.trim()) result.push(current.trim())
  return result
}

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

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    return value.slice(1, -1)
  return value
}

function pathArguments(tokens: string[]): string[] {
  return tokens
    .slice(1)
    .filter((token) => token && !token.startsWith("-"))
    .map(unquote)
}

function assessment(
  command: string,
  risk: ToolAssessment["risk"],
  reason: string,
  targets: string[] = [],
  findings: PermissionFinding[] = [],
  coverageGaps: PermissionCoverageGap[] = [],
): ToolAssessment {
  return {
    summary: `执行命令：${command}`,
    targets,
    risk,
    reason,
    findings,
    ...(coverageGaps.length > 0 ? { coverageGaps } : {}),
    details: { command },
    match: { command },
    recoveryChecks: ["检查命令涉及的文件、进程或远程资源是否已发生变化"],
  }
}

function finding(
  severity: PermissionFinding["severity"],
  category: string,
  summary: string,
  evidence: string,
): PermissionFinding {
  return { severity, category, summary, evidence }
}

function coverageGap(
  code: string,
  kind: PermissionCoverageGap["kind"],
  summary: string,
  evidence?: string,
): PermissionCoverageGap {
  return { code, kind, summary, ...(evidence === undefined ? {} : { evidence }) }
}

function networkReview(tokens: string[], request: ToolPermissionRequest, command: string): ToolPermissionDecision {
  const executable = tokens[0]?.toLowerCase()
  const target = tokens.find((token) => /^https?:\/\//i.test(unquote(token)))
  const dynamic = !target || /[$`]/.test(target)
  const upload = tokens.some((token) =>
    ["-d", "--data", "--data-binary", "-F", "--form", "-T", "--upload-file"].includes(token),
  )
  const methodIndex = tokens.findIndex((token) => token === "-X" || token === "--request")
  const method =
    methodIndex >= 0 ? unquote(tokens[methodIndex + 1] ?? "").toUpperCase() : executable === "wget" ? "GET" : "GET"
  const reason = "网络请求需要审核"
  const severity = dynamic || upload || !["GET", "HEAD"].includes(method) ? "high" : "medium"
  const networkGap = coverageGap(
    "bash.network-coarse-rule",
    "coarse-rule",
    "网络命令只按有限参数和请求方法分类",
    command,
  )
  const analyzed = assessment(
    command,
    severity,
    reason,
    target ? [unquote(target)] : [],
    [finding(severity, "network", reason, command)],
    [networkGap],
  )
  if (dynamic || upload || !["GET", "HEAD"].includes(method)) return { type: "needHumanReview", assessment: analyzed }
  return {
    type: "needAiReview",
    assessment: analyzed,
    reviewPayload: {
      command,
      destination: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(unquote(target))
        ? "loopback"
        : "remote",
      operation: "read",
      method,
      declaredIntent: request.declaredIntent,
    },
  }
}

function simpleDecision(segment: string, request: ToolPermissionRequest): ToolPermissionDecision {
  const tokens = tokenize(segment)
  if (!tokens || tokens.length === 0)
    return {
      type: "needHumanReview",
      assessment: assessment(
        segment,
        "high",
        "命令无法可靠解析",
        [],
        [],
        [coverageGap("bash.parse-failure", "parse-failure", "命令无法可靠解析", segment)],
      ),
    }
  const executable =
    unquote(tokens[0] ?? "")
      .split(/[\\/]/)
      .at(-1)
      ?.toLowerCase() ?? ""
  if (humanCommands.has(executable))
    return {
      type: "needHumanReview",
      assessment: assessment(
        segment,
        "high",
        "命令会修改系统级状态",
        [],
        [finding("high", "system-mutation", "命令会修改系统级状态", segment)],
      ),
    }
  if (networkCommands.has(executable)) return networkReview(tokens, request, segment)
  if (executable === "git") {
    const subcommand = tokens
      .slice(1)
      .find((token) => !token.startsWith("-"))
      ?.toLowerCase()
    if (subcommand && safeGitCommands.has(subcommand))
      return { type: "allow", assessment: assessment(segment, "low", "只读 Git 查询") }
    if (subcommand && remoteMutationCommands.has(subcommand))
      return {
        type: "needHumanReview",
        assessment: assessment(
          segment,
          "high",
          "Git 远程操作需要用户判断",
          [],
          [finding("high", "remote-mutation", "Git 远程操作需要用户判断", segment)],
        ),
      }
    return {
      type: "needAiReview",
      assessment: assessment(
        segment,
        "medium",
        "Git 操作可能修改工作区或历史",
        [],
        [],
        [coverageGap("bash.git-coarse-rule", "coarse-rule", "Git 子命令没有精细规则", segment)],
      ),
      reviewPayload: { command: segment, declaredIntent: request.declaredIntent },
    }
  }
  if (safeCommands.has(executable)) {
    if (
      executable === "rg" &&
      tokens.some(
        (token) =>
          token === "--pre" ||
          token.startsWith("--pre=") ||
          token === "--hostname-bin" ||
          token.startsWith("--hostname-bin=") ||
          token === "--search-zip" ||
          token === "-z",
      )
    )
      return {
        type: "needHumanReview",
        assessment: assessment(
          segment,
          "high",
          "rg 参数会调用其他程序",
          [],
          [finding("high", "dynamic-execution", "rg 参数会调用其他程序", segment)],
        ),
      }
    const targets = pathArguments(tokens)
      .map((path) => resolve(request.cwd, path))
      .filter((path) => isAbsolute(path))
    if (targets.some((path) => !inside(resolve(request.cwd), path)))
      return {
        type: "needHumanReview",
        assessment: assessment(segment, "high", "命令读取工作区外路径", targets, [
          finding("high", "outside-workspace", "命令读取工作区外路径", segment),
        ]),
      }
    return { type: "allow", assessment: assessment(segment, "low", "命中保守只读命令规则", targets) }
  }
  if (packageCommands.has(executable))
    return {
      type: "needAiReview",
      assessment: assessment(
        segment,
        "medium",
        "包管理或构建命令可能写入文件并执行脚本",
        [],
        [],
        [coverageGap("bash.package-coarse-rule", "coarse-rule", "包管理命令没有按子命令精细分类", segment)],
      ),
      reviewPayload: { command: segment, declaredIntent: request.declaredIntent },
    }
  if (executable === "rm" || executable === "mv" || executable === "cp" || executable === "mkdir") {
    const targets = pathArguments(tokens).map((path) => resolve(request.cwd, path))
    if (targets.some((path) => !inside(resolve(request.cwd), path)))
      return {
        type: "needHumanReview",
        assessment: assessment(segment, "high", "命令修改工作区外路径", targets, [
          finding("high", "outside-workspace", "命令修改工作区外路径", segment),
        ]),
      }
    return {
      type: "needAiReview",
      assessment: assessment(
        segment,
        "medium",
        "命令会修改工作区文件",
        targets,
        [],
        [coverageGap("bash.filesystem-coarse-rule", "coarse-rule", "文件操作只按目标是否位于工作区分类", segment)],
      ),
      reviewPayload: { command: segment, targets, declaredIntent: request.declaredIntent },
    }
  }
  return {
    type: "needAiReview",
    assessment: assessment(
      segment,
      "medium",
      "可执行命令未命中只读规则",
      [],
      [],
      [coverageGap("bash.command-rule-miss", "rule-miss", "可执行命令未命中语义规则", segment)],
    ),
    reviewPayload: { command: segment, declaredIntent: request.declaredIntent },
  }
}

function combine(left: ToolPermissionDecision, right: ToolPermissionDecision): ToolPermissionDecision {
  const rank = { allow: 0, needAiReview: 1, needHumanReview: 2, deny: 3 } as const
  const selected = rank[right.type] > rank[left.type] ? right : left
  const findings = [...left.assessment.findings, ...right.assessment.findings]
  const coverageGaps = [...(left.assessment.coverageGaps ?? []), ...(right.assessment.coverageGaps ?? [])]
  const targets = [...new Set([...left.assessment.targets, ...right.assessment.targets])]
  const assessment = {
    ...selected.assessment,
    targets,
    findings,
    ...(coverageGaps.length > 0 ? { coverageGaps } : {}),
  }
  return selected.type === "deny"
    ? { ...selected, assessment }
    : selected.type === "needAiReview"
      ? { ...selected, assessment }
      : selected.type === "needHumanReview"
        ? { ...selected, assessment }
        : { ...selected, assessment }
}

/** 创建首期面向 Git Bash 保守语法子集的权限验证器。 */
export function createBashValidator(): ToolPermissionValidator {
  return {
    toolName: "bash",
    async validate(request) {
      const input = object(request.arguments)
      const command = input?.command
      if (!input || typeof command !== "string" || !command.trim()) {
        const invalid = assessment("", "critical", "命令为空或格式无效")
        return { type: "deny", reason: invalid.reason, assessment: invalid }
      }
      if (destructiveRoot.test(command) || forkBomb.test(command)) {
        const reason = "命令命中明确的全系统破坏模式"
        const destructive = assessment(
          command,
          "critical",
          reason,
          [],
          [finding("critical", "system-destruction", reason, command)],
        )
        return { type: "deny", reason: destructive.reason, assessment: destructive }
      }
      if (request.environment && object(request.environment)?.shell !== "git-bash")
        return {
          type: "needHumanReview",
          assessment: assessment(
            command,
            "high",
            "当前 Shell 不在首期分析范围内",
            [],
            [],
            [coverageGap("bash.unsupported-shell", "unsupported-environment", "当前 Shell 不在分析范围内")],
          ),
        }
      if (unsupportedSyntax.test(command) || hasUnsupportedControlSyntax(command))
        return {
          type: "needHumanReview",
          assessment: assessment(
            command,
            "high",
            "命令使用了首期不可靠支持的动态语法",
            [],
            [],
            [coverageGap("bash.unsupported-syntax", "unsupported-syntax", "命令使用了不可靠支持的语法", command)],
          ),
        }
      const segments = splitCommands(command)
      if (!segments || segments.length === 0)
        return {
          type: "needHumanReview",
          assessment: assessment(
            command,
            "high",
            "命令无法可靠拆分",
            [],
            [],
            [coverageGap("bash.parse-failure", "parse-failure", "命令无法可靠拆分", command)],
          ),
        }
      return segments.map((segment) => simpleDecision(segment, request)).reduce(combine)
    },
  }
}
