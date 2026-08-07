import { isAbsolute, relative, resolve } from "node:path"
import type { JsonValue } from "../../session-format.ts"
import type { PermissionClassifier, PermissionClassifyContext } from "../classifier-types.ts"
import type { PermissionClaim, PermissionTag } from "../policy-types.ts"

const dynamicSyntax = /`|\$\(|\$\{|\$[A-Za-z_][A-Za-z0-9_]*/

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

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function editTag(target: string, context: PermissionClassifyContext): PermissionTag {
  if (inside(resolve(context.workspaceRoot), target)) return "edit-workspace"
  if (context.homeDirectory && inside(resolve(context.homeDirectory), target)) return "edit-home"
  return "edit-system"
}

function claim(tag: PermissionTag, reason: string): PermissionClaim {
  return { tag, reason }
}

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

/** 创建首期只覆盖简单 npm 命令语义的 Bash 分类器。 */
export function createBuiltinBashClassifier(): PermissionClassifier {
  return {
    id: "builtin/bash@1",
    toolNames: ["bash"],
    classify(input, context) {
      const command = input.command ?? object(input.arguments)?.command
      if (typeof command !== "string" || !command.trim() || dynamicSyntax.test(command)) return { kind: "abstain" }
      const tokens = tokenize(command)
      if (!tokens || tokens.length === 0) return { kind: "abstain" }
      const executable = tokens[0]?.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase()
      if (executable !== "npm" && executable !== "npm.cmd" && executable !== "npm.exe") return { kind: "abstain" }
      const claims = npmClaims(tokens, input.cwd, context)
      return claims ? { kind: "claims", claims } : { kind: "abstain" }
    },
  }
}
