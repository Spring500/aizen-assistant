import { lstat, readFile, realpath } from "node:fs/promises"
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import type { JsonValue } from "../../session-format.ts"
import { previewExactEdits } from "../edit-preview.ts"
import { containsSensitiveField } from "../sanitizer.ts"
import type { ToolAssessment, ToolPermissionRequest, ToolPermissionValidator } from "../types.ts"

const executionSensitiveNames = new Set([
  "package.json",
  "bun.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "dockerfile",
  "makefile",
])
const executionSensitiveExtensions = new Set([".sh", ".bash", ".ps1", ".cmd", ".bat", ".exe", ".dll", ".so"])
const ordinaryExtensions = new Set([
  ".c",
  ".cpp",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".py",
  ".rs",
  ".scss",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
])
const sensitiveNames = new Set([".env", ".npmrc", ".pypirc", "credentials", "credentials.json", "id_rsa", "id_ed25519"])

function object(value: JsonValue): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

async function canonicalExistingParent(path: string): Promise<{ target: string; exists: boolean }> {
  let current = path
  const suffix: string[] = []
  while (true) {
    try {
      await lstat(current)
      const parent = await realpath(current)
      return { target: resolve(parent, ...suffix.reverse()), exists: suffix.length === 0 }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
      const parent = dirname(current)
      if (parent === current) throw new Error(`无法解析路径：${path}`)
      suffix.push(current.slice(parent.length).replace(/^[/\\]+/, ""))
      current = parent
    }
  }
}

function sensitivePath(path: string): boolean {
  const parts = path.toLowerCase().split(/[\\/]+/)
  const name = parts.at(-1) ?? ""
  return (
    sensitiveNames.has(name) ||
    parts.includes(".git") ||
    parts.includes(".aizen") ||
    parts.includes(".ssh") ||
    parts.includes("auth.json") ||
    /\.(pem|key|p12|pfx)$/.test(name)
  )
}

function executionSensitive(path: string): boolean {
  const lower = path.toLowerCase()
  const name = lower.split(/[\\/]+/).at(-1) ?? ""
  return (
    executionSensitiveNames.has(name) ||
    executionSensitiveExtensions.has(extname(name)) ||
    lower.includes(`${sep}.github${sep}workflows`) ||
    lower.includes(`${sep}scripts${sep}`)
  )
}

function edits(value: JsonValue): Array<{ oldText: string; newText: string }> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const result: Array<{ oldText: string; newText: string }> = []
  for (const item of value) {
    const source = object(item)
    if (!source || typeof source.oldText !== "string" || typeof source.newText !== "string") return undefined
    result.push({ oldText: source.oldText, newText: source.newText })
  }
  return result
}

async function editDetails(path: string, input: Record<string, JsonValue>): Promise<JsonValue> {
  const replacements = input.edits === undefined ? undefined : edits(input.edits)
  if (!replacements) return { path, edits: input.edits ?? [], previewError: "替换列表格式无效" }
  try {
    const content = await readFile(path, "utf8")
    const preview = previewExactEdits(path, content, replacements)
    return preview.ok
      ? { path, edits: replacements, patch: preview.patch }
      : {
          path,
          edits: replacements,
          previewError: preview.reason,
          ...(preview.failedEditIndex === undefined ? {} : { failedEditIndex: preview.failedEditIndex }),
        }
  } catch (error) {
    return {
      path,
      edits: replacements,
      previewError: `无法读取原文件：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function details(toolName: string, path: string, input: Record<string, JsonValue>): JsonValue {
  if (toolName === "read") return { path, offset: input.offset ?? null, limit: input.limit ?? null }
  if (toolName === "write") return { path, content: input.content ?? "" }
  return { path, edits: input.edits ?? [] }
}

function assessment(
  summary: string,
  target: string,
  risk: ToolAssessment["risk"],
  reason: string,
  normalizedArguments: JsonValue,
  localDetails: JsonValue,
): ToolAssessment {
  const finding =
    risk === "low"
      ? []
      : [
          {
            severity:
              risk === "medium" ? ("medium" as const) : risk === "high" ? ("high" as const) : ("critical" as const),
            category: "file-target",
            summary: reason,
            evidence: target,
          },
        ]
  return {
    summary,
    targets: [target],
    risk,
    reason,
    findings: finding,
    normalizedArguments,
    details: localDetails,
    match: { path: target },
    recoveryChecks: [`检查 ${target} 的当前内容和修改时间`],
  }
}

/** 为一个内置文件工具创建按实际路径判断的权限验证器。 */
export function createFileValidator(toolName: "read" | "write" | "edit"): ToolPermissionValidator {
  return {
    toolName,
    async validate(request: ToolPermissionRequest) {
      const input = object(request.arguments)
      const rawPath = input?.path
      if (!input || typeof rawPath !== "string" || !rawPath.trim()) {
        const invalid = assessment(toolName, "", "critical", "文件路径无效", request.arguments, request.arguments)
        return { type: "deny", reason: invalid.reason, assessment: invalid }
      }
      const absolute = resolve(request.cwd, rawPath)
      let resolved: Awaited<ReturnType<typeof canonicalExistingParent>>
      try {
        resolved = await canonicalExistingParent(absolute)
      } catch (error) {
        const invalid = assessment(
          `${toolName} ${absolute}`,
          absolute,
          "critical",
          error instanceof Error ? error.message : String(error),
          request.arguments,
          details(toolName, absolute, input),
        )
        return { type: "deny", reason: invalid.reason, assessment: invalid }
      }
      const normalized = { ...input, path: resolved.target }
      const action = toolName === "read" ? "读取" : toolName === "write" ? "写入" : "编辑"
      const localDetails =
        toolName === "edit" ? await editDetails(resolved.target, input) : details(toolName, resolved.target, input)
      const analyzed = assessment(
        `${action} ${resolved.target}`,
        resolved.target,
        "low",
        "目标位于工作区内的普通文件",
        normalized,
        localDetails,
      )
      if (
        toolName === "edit" &&
        localDetails &&
        typeof localDetails === "object" &&
        !Array.isArray(localDetails) &&
        typeof localDetails.previewError === "string"
      ) {
        analyzed.risk = "high"
        analyzed.reason = `无法可靠预演编辑：${localDetails.previewError}`
        analyzed.findings = [
          {
            severity: "high",
            category: "edit-preview",
            summary: "无法生成可靠 diff",
            evidence: localDetails.previewError,
          },
        ]
        return { type: "deny", reason: analyzed.reason, assessment: analyzed }
      }
      const root = await realpath(request.cwd).catch(() => resolve(request.cwd))
      if (!inside(root, resolved.target) || sensitivePath(resolved.target)) {
        analyzed.risk = "high"
        analyzed.reason = !inside(root, resolved.target) ? "目标位于工作区外" : "目标属于敏感路径"
        analyzed.findings = [
          {
            severity: "high",
            category: !inside(root, resolved.target) ? "outside-workspace" : "sensitive-path",
            summary: analyzed.reason,
            evidence: resolved.target,
          },
        ]
        return { type: "needHumanReview", assessment: analyzed }
      }
      if (toolName === "read") return { type: "allow", assessment: analyzed }
      if (containsSensitiveField(request.arguments)) {
        analyzed.risk = "high"
        analyzed.reason = "工具参数包含敏感字段"
        analyzed.findings = [
          {
            severity: "high",
            category: "sensitive-argument",
            summary: analyzed.reason,
            evidence: resolved.target,
          },
        ]
        return { type: "needHumanReview", assessment: analyzed }
      }
      const extension = extname(resolved.target).toLowerCase()
      if (executionSensitive(resolved.target) || (!ordinaryExtensions.has(extension) && extension !== "")) {
        analyzed.risk = "medium"
        analyzed.reason = "目标可能影响后续执行或发布"
        analyzed.findings = [
          {
            severity: "medium",
            category: "execution-sensitive-file",
            summary: analyzed.reason,
            evidence: resolved.target,
          },
        ]
        return {
          type: "needAiReview",
          assessment: analyzed,
          reviewPayload: { path: resolved.target, operation: toolName, exists: resolved.exists },
        }
      }
      return { type: "allow", assessment: analyzed }
    },
  }
}
