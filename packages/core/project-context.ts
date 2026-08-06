import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import type { ProjectSources } from "./view-config.ts"

/**
 * 工作路径上下文加载行为。
 *
 * 每种"加载行为"是一个自包含的实现对象：阅读某个行为即可看到该行为加载
 * AGENTS 文件与 skill 目录的全部逻辑（候选文件名、停止条件）。
 * 新增一种行为（例如 claude-code 默认：只读 CLAUDE.md、skill 取 .claude/skills）：
 * 1. 在 view-config.ts 的 ProjectSources 加一个枚举值；
 * 2. 在本文件向 projectSourceBehaviors 注册一个实现（可复用下方的共享收集器，
 *    或按需自行实现遍历逻辑）。
 */
export type ProjectBoundary = Exclude<ProjectSources, "none">

export type AgentsFile = { path: string; content: string }

export type ProjectSourceBehavior = {
  id: ProjectBoundary
  /** 该行为下从工作路径收集的 AGENTS/CLAUDE 文件。 */
  resolveAgentsFiles(cwd: string): AgentsFile[]
  /** 该行为下从工作路径收集的 skill 目录。 */
  resolveSkillPaths(cwd: string): string[]
}

/** 每级目录候选文件名，按优先级排列；只取第一个存在的（对齐 pi 的 loadContextFileFromDir）。 */
const DEFAULT_AGENTS_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const

type StopPredicate = (dir: string, gitRoot: string | null) => boolean

/** 向上查找 git 仓库根目录（.git 目录或文件），找不到返回 null。 */
export function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir)
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 冒泡停止条件：收集完当前目录后立即停下（只读工作目录）。 */
const stopAfterCwd: StopPredicate = () => true
/** 冒泡停止条件：到 git 仓库根（无 git 时到文件系统根）。 */
const stopAtGitRoot: StopPredicate = (dir, gitRoot) => gitRoot !== null && dir === gitRoot
/** 冒泡停止条件：到文件系统根（永不提前停）。 */
const stopAtFilesystemRoot: StopPredicate = () => false

/**
 * 从 cwd 向上收集 AGENTS/CLAUDE 文件。
 * 每级目录按 candidates 顺序只取第一个存在的；返回顺序为远到近（工作目录最后、优先级最高）。
 */
function collectAgentsFiles(cwd: string, candidates: readonly string[], stop: StopPredicate): AgentsFile[] {
  const gitRoot = findGitRoot(cwd)
  const files: AgentsFile[] = []
  let dir = resolve(cwd)
  while (true) {
    for (const name of candidates) {
      const path = join(dir, name)
      if (existsSync(path)) {
        files.unshift({ path, content: readFileSync(path, "utf8") })
        break
      }
    }
    if (stop(dir, gitRoot)) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return files
}

/**
 * 从 cwd 向上收集 skill 目录：<cwd>/.pi/skills 与各目录的 .agents/skills。
 * 遵循 pi 的项目技能约定；不同约定的行为可在 resolveSkillPaths 中自行实现。
 */
function collectPiSkillPaths(cwd: string, stop: StopPredicate): string[] {
  const gitRoot = findGitRoot(cwd)
  const resolvedCwd = resolve(cwd)
  const paths: string[] = []
  const piSkills = join(resolvedCwd, ".pi", "skills")
  if (existsSync(piSkills)) paths.push(piSkills)
  let dir = resolvedCwd
  while (true) {
    const agentsSkills = join(dir, ".agents", "skills")
    if (existsSync(agentsSkills)) paths.push(agentsSkills)
    if (stop(dir, gitRoot)) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return paths
}

/**
 * 工作路径上下文加载行为注册表。按需新增行为时在此追加条目。
 */
export const projectSourceBehaviors: Record<ProjectBoundary, ProjectSourceBehavior> = {
  cwd: {
    id: "cwd",
    /** 只加载当前工作目录的 AGENTS 文件与技能。 */
    resolveAgentsFiles: (cwd) => collectAgentsFiles(cwd, DEFAULT_AGENTS_CANDIDATES, stopAfterCwd),
    resolveSkillPaths: (cwd) => collectPiSkillPaths(cwd, stopAfterCwd),
  },
  "git-root": {
    id: "git-root",
    /** AGENTS 文件与技能都冒泡到 git 仓库根。 */
    resolveAgentsFiles: (cwd) => collectAgentsFiles(cwd, DEFAULT_AGENTS_CANDIDATES, stopAtGitRoot),
    resolveSkillPaths: (cwd) => collectPiSkillPaths(cwd, stopAtGitRoot),
  },
  "pi-default": {
    id: "pi-default",
    /** 对齐 pi 原生：AGENTS 文件冒泡到文件系统根；技能只到 git 仓库根。 */
    resolveAgentsFiles: (cwd) => collectAgentsFiles(cwd, DEFAULT_AGENTS_CANDIDATES, stopAtFilesystemRoot),
    resolveSkillPaths: (cwd) => collectPiSkillPaths(cwd, stopAtGitRoot),
  },
}

export type ResolvedProjectSources = { agentsFiles: AgentsFile[]; skillPaths: string[] }

/** 按加载行为解析工作路径上下文资源。 */
export function resolveProjectSources(cwd: string, boundary: ProjectBoundary): ResolvedProjectSources {
  const behavior = projectSourceBehaviors[boundary]
  return {
    agentsFiles: behavior.resolveAgentsFiles(cwd),
    skillPaths: behavior.resolveSkillPaths(cwd),
  }
}
