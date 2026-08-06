import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { atomicWriteFile } from "./file-transaction.ts"

/**
 * 项目路径下 AGENTS.md 与 Skill 的加载范围：
 * - "none"：不加载；
 * - "cwd"：只加载当前工作目录；
 * - "git-root"：加载工作目录及仓库内上级目录；
 * - "pi-default"：AGENTS.md 沿上级目录到文件系统根，Skill 到 git 仓库根。
 */
export type ProjectSources = "none" | "cwd" | "pi-default" | "git-root"

export type ViewConfig = {
  projectSources: ProjectSources
  loadUserSkills: boolean
}

export const DEFAULT_VIEW_CONFIG: ViewConfig = {
  projectSources: "none",
  loadUserSkills: true,
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label} 包含未知字段：${key}`)
}

export function parseViewConfigValue(value: unknown): ViewConfig {
  const source = object(value, "config.json")
  exact(source, ["projectSources", "loadUserSkills"], "config.json")
  const projectSources = source.projectSources
  if (
    projectSources !== "none" &&
    projectSources !== "cwd" &&
    projectSources !== "pi-default" &&
    projectSources !== "git-root"
  )
    throw new Error("config.json.projectSources 必须是 none、cwd、pi-default 或 git-root")
  const loadUserSkills = source.loadUserSkills
  if (typeof loadUserSkills !== "boolean") throw new Error("config.json.loadUserSkills 必须是布尔值")
  return { projectSources, loadUserSkills }
}

export type ReadViewConfigResult = {
  config: ViewConfig
  error?: string
}

/**
 * 读取视图行为配置。文件缺失或非法时一律使用默认值并附带错误说明，
 * 不阻断视图使用（缺失视为尚未配置，非法视为可修复问题）。
 */
export async function readViewConfig(directory: string): Promise<ReadViewConfigResult> {
  let text: string
  try {
    text = await readFile(join(directory, "config.json"), "utf8")
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return { config: { ...DEFAULT_VIEW_CONFIG } }
    return {
      config: { ...DEFAULT_VIEW_CONFIG },
      error: `无法读取 config.json：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  try {
    return { config: parseViewConfigValue(JSON.parse(text)) }
  } catch (error) {
    return {
      config: { ...DEFAULT_VIEW_CONFIG },
      error: `config.json 配置错误：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function writeViewConfig(directory: string, config: ViewConfig): Promise<void> {
  await atomicWriteFile(join(directory, "config.json"), `${JSON.stringify(config, null, 2)}\n`)
}
