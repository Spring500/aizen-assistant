import { isAbsolute, relative, resolve } from "node:path"
import type { JsonValue } from "../../session-format.ts"
import { parseBash } from "../parsers/bash.ts"
import type { PermissionClassifier, PermissionClassifyContext } from "../classifier-types.ts"
import type { PermissionClaim, PermissionTag } from "../policy-types.ts"

const safeReadCommands = new Set([
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
const systemChangeCommands = new Set([
  "chmod",
  "chown",
  "dd",
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
const remoteFetchCommands = new Set(["fetch", "pull", "clone"])
const packageCommands = new Set(["bun", "pnpm", "yarn", "cargo", "pip", "pip3"])
const filesystemCommands = new Set(["rm", "mv", "cp", "mkdir"])

/** 明确的全系统破坏模式：递归删除系统根或盘符根。 */
const destructiveRoot =
  /\brm\b[^\n]*(?:-\w*r\w*f|-\w*f\w*r|--recursive)[^\n]*(?:\s\/\s*$|\s\/[\s;&|]|\s[A-Za-z]:[\\/]\s*$)/i

function object(value: JsonValue): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
}

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

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    return value.slice(1, -1)
  return value
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function readTag(target: string, context: PermissionClassifyContext): PermissionTag {
  if (inside(resolve(context.workspaceRoot), target)) return "read-workspace"
  if (context.homeDirectory && inside(resolve(context.homeDirectory), target)) return "read-home"
  return "read-system"
}

function editTag(target: string, context: PermissionClassifyContext): PermissionTag {
  if (inside(resolve(context.workspaceRoot), target)) return "edit-workspace"
  if (context.homeDirectory && inside(resolve(context.homeDirectory), target)) return "edit-home"
  return "edit-system"
}

function claim(tag: PermissionTag, reason: string): PermissionClaim {
  return { tag, reason }
}

/** 路径参数对应的作用域标签（读取类）。 */
function readPathClaims(tokens: string[], cwd: string, context: PermissionClassifyContext): PermissionClaim[] {
  return tokens
    .slice(1)
    .filter((token) => token && !token.startsWith("-"))
    .map(unquote)
    .map((path) => resolve(cwd, path))
    .map((target) => claim(readTag(target, context), `命令会读取目标：${target}`))
}

/** npm 子命令的细粒度语义（保留既有实现）。 */
function npmClaims(tokens: string[], cwd: string, context: PermissionClassifyContext): PermissionClaim[] | undefined {
  let index = 1
  let prefix: string | undefined
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === "--prefix") {
      prefix = tokens[index + 1]
      if (!prefix) return undefined
      index += 2
      continue
    }
    if (token?.startsWith("--prefix=")) {
      prefix = token.slice("--prefix=".length)
      index++
      continue
    }
    if (token?.startsWith("-")) {
      index++
      continue
    }
    break
  }
  const subcommand = tokens[index]?.toLowerCase()
  if (!subcommand) return undefined
  const target = resolve(cwd, prefix ?? ".")
  const write = claim(editTag(target, context), `npm ${subcommand} 会写入安装目标：${target}`)
  if (["install", "i", "ci", "update", "up"].includes(subcommand))
    return [claim("network-fetch", `npm ${subcommand} 会从 registry 获取包`), write]
  if (["uninstall", "remove", "rm", "un", "unlink"].includes(subcommand)) return [write]
  if (subcommand === "publish") return [claim("network-send", "npm publish 会向 registry 上传包")]
  return undefined
}

/** 对单个节点分类：返回声称列表（空数组即正面担保）或 abstain（无法判定）。 */
function classifyNode(
  text: string,
  input: { cwd: string },
  context: PermissionClassifyContext,
): PermissionClaim[] | "abstain" {
  const tokens = tokenize(text)
  if (!tokens || tokens.length === 0) return "abstain"
  const executable = tokens[0]?.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase()
  if (!executable) return "abstain"
  if (executable === "npm" || executable === "npm.cmd" || executable === "npm.exe") {
    const claims = npmClaims(tokens, input.cwd, context)
    return claims ?? "abstain"
  }
  if (packageCommands.has(executable)) {
    const target = resolve(input.cwd)
    return [
      claim("network-fetch", `${executable} 会从包仓库获取依赖`),
      claim(editTag(target, context), `${executable} 会写入当前工作区`),
    ]
  }
  if (networkCommands.has(executable)) {
    const target = tokens.map(unquote).find((token) => /^https?:\/\//i.test(token))
    if (!target) return "abstain"
    const uploadFlag = tokens.some((token) =>
      ["-d", "--data", "--data-binary", "-F", "--form", "-T", "--upload-file"].includes(token),
    )
    const methodIndex = tokens.findIndex((token) => token === "-X" || token === "--request")
    const method =
      methodIndex >= 0 ? unquote(tokens[methodIndex + 1] ?? "").toUpperCase() : executable === "wget" ? "GET" : "GET"
    if (uploadFlag || !["GET", "HEAD"].includes(method))
      return [claim("network-send", `${executable} 会向网络发送数据`)]
    return [claim("network-fetch", `${executable} 会从网络获取数据`)]
  }
  if (executable === "git") {
    const subcommand = tokens
      .slice(1)
      .find((token) => !token.startsWith("-"))
      ?.toLowerCase()
    if (subcommand && safeGitCommands.has(subcommand)) return []
    if (subcommand && remoteFetchCommands.has(subcommand))
      return [claim("network-fetch", `git ${subcommand} 会从远程仓库获取数据`)]
    if (subcommand === "push") return [claim("network-send", "git push 会向远程仓库发送提交")]
    return "abstain"
  }
  if (systemChangeCommands.has(executable)) return [claim("system-change", `${executable} 会改变系统状态`)]
  if (filesystemCommands.has(executable)) {
    const targets = tokens
      .slice(1)
      .filter((token) => token && !token.startsWith("-"))
      .map(unquote)
      .map((path) => resolve(input.cwd, path))
    if (targets.length === 0) return "abstain"
    // 递归删除系统根或盘符根属于任何场景都不应发生的行为。
    if (destructiveRoot.test(text)) return [claim("violation", "递归删除系统根或盘符根：" + text)]
    return targets.map((target) => claim(editTag(target, context), `${executable} 会修改目标：${target}`))
  }
  if (safeReadCommands.has(executable)) {
    // 仅将明显是路径的参数（含分隔符或以 . 开头）当作目标，避免 echo/pwd 等输出命令误判。
    const targets = tokens
      .slice(1)
      .filter((token) => token && !token.startsWith("-") && (token.includes("/") || token.startsWith(".")))
      .map(unquote)
      .map((path) => resolve(input.cwd, path))
    if (targets.length === 0) return []
    return targets.map((target) => claim(readTag(target, context), `${executable} 会读取目标：${target}`))
  }
  return "abstain"
}

/** 创建覆盖 bash 命令的解析 + 分类分类器；结构性拒绝声称 violation，任一节点无法判定则整体弃权。 */
export function createBuiltinBashClassifier(): PermissionClassifier {
  return {
    id: "builtin/bash@1",
    toolNames: ["bash"],
    classify(input, context) {
      const command = input.command ?? object(input.arguments)?.command
      if (typeof command !== "string" || !command.trim()) return { kind: "abstain" }
      const parsed = parseBash(command)
      if (parsed.kind === "structural-deny") return { kind: "claims", claims: [claim("violation", parsed.reason)] }
      if (parsed.kind === "unknown") return { kind: "abstain" }
      const claims: PermissionClaim[] = []
      for (const node of parsed.nodes) {
        const nodeClaims = classifyNode(node.text, input, context)
        if (nodeClaims === "abstain") return { kind: "abstain" }
        claims.push(...nodeClaims)
      }
      return { kind: "claims", claims }
    },
  }
}
