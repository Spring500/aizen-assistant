import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { JsonValue } from "../../session-format.ts"
import type { PermissionClassifier, PermissionClassifyContext } from "../classifier-types.ts"
import type { PermissionClaim, PermissionTag } from "../policy-types.ts"

const readTools = new Set(["read", "grep", "find", "ls"])
const editTools = new Set(["write", "edit"])

function object(value: JsonValue): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

async function canonicalPath(path: string): Promise<string> {
  let current = path
  const suffix: string[] = []
  while (true) {
    try {
      await lstat(current)
      return resolve(await realpath(current), ...suffix.reverse())
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
      const parent = dirname(current)
      if (parent === current) throw error
      suffix.push(current.slice(parent.length).replace(/^[/\\]+/, ""))
      current = parent
    }
  }
}

function sensitive(target: string, context: PermissionClassifyContext, dataDirectory?: string): boolean {
  const normalized = target.replace(/\\/g, "/").toLowerCase()
  const segments = normalized.split("/")
  const name = segments.at(-1) ?? ""
  // 私钥与证书扩展名后缀规则（与路径段规则互补）。
  if (/\.(pem|key|p12|pfx)$/.test(name)) return true
  // 数据目录整体视为敏感，不依赖目录名。
  if (dataDirectory && inside(dataDirectory, target)) return true
  return context.sensitivePaths.some((pattern) => {
    const value = pattern.replace(/\\/g, "/").toLowerCase()
    return value.includes("/") ? normalized.includes(value) : segments.includes(value)
  })
}

function protectedPermissionPath(target: string, dataDirectory?: string): boolean {
  return dataDirectory ? inside(dataDirectory, target) : false
}

function claim(tag: PermissionTag, reason: string): PermissionClaim {
  return { tag, reason }
}

/** 创建覆盖 read/write/edit/grep/find/ls 的内置文件作用域分类器。 */
export function createBuiltinFileClassifier(): PermissionClassifier {
  return {
    id: "builtin/file@1",
    toolNames: [...readTools, ...editTools],
    async classify(input, context) {
      const argumentsValue = object(input.arguments)
      if (!argumentsValue) return { kind: "abstain" }
      const rawPath = argumentsValue.path
      if (rawPath !== undefined && typeof rawPath !== "string") return { kind: "abstain" }
      const target = await canonicalPath(resolve(input.cwd, rawPath || ".")).catch(() => undefined)
      if (!target) return { kind: "abstain" }
      const operation = readTools.has(input.toolName) ? "read" : editTools.has(input.toolName) ? "edit" : undefined
      if (!operation) return { kind: "abstain" }
      const workspace = await realpath(context.workspaceRoot).catch(() => resolve(context.workspaceRoot))
      const home = context.homeDirectory
        ? await realpath(context.homeDirectory).catch(() => resolve(context.homeDirectory as string))
        : undefined
      const dataDirectory = context.dataDirectory
        ? await realpath(context.dataDirectory).catch(() => resolve(context.dataDirectory as string))
        : undefined
      const claims: PermissionClaim[] = []
      if (inside(workspace, target))
        claims.push(claim(`${operation}-workspace`, `目标路径位于工作区：${target}` as string))
      if (home && inside(home, target)) claims.push(claim(`${operation}-home`, `目标路径位于用户目录：${target}`))
      if (!inside(workspace, target) && (!home || !inside(home, target)))
        claims.push(claim(`${operation}-system`, `目标路径位于工作区和用户目录之外：${target}`))
      if (sensitive(target, context, dataDirectory))
        claims.push(claim(`${operation}-sensitive`, `目标路径命中敏感路径：${target}`))
      if (operation === "edit" && protectedPermissionPath(target, dataDirectory))
        claims.push(
          claim(
            "violation",
            `target path ${target} is inside the application data directory, which the permission system manages and the agent must not modify; write to a path inside the workspace instead`,
          ),
        )
      return { kind: "claims", claims }
    },
  }
}
