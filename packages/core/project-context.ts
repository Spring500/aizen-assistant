import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import type { ProjectSources } from "./view-config.ts"

/**
 * 项目路径资源发现。AA 自管全部项目层加载（pi 的 noContextFiles / noSkills
 * 保持关闭），因此这里的边界由我们控制：
 * - "pi-default"：AGENTS.md 冒泡到文件系统根；skills 的 .agents 冒泡到 git 根（无 git 时到文件系统根）。
 * - "git-root"：统一限定到 git 根；无 git 仓库时退化为 pi-default 行为。
 */
export type ProjectBoundary = Exclude<ProjectSources, "none">

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

const CONTEXT_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const

export type AgentsFile = { path: string; content: string }

/**
 * 收集从 cwd 向上的项目上下文文件（AGENTS.md / CLAUDE.md）。
 * 返回顺序为远到近，最近的作为最高优先（视图 AGENTS.md 在其后拼接）。
 */
export function loadProjectAgentsFiles(cwd: string, boundary: ProjectBoundary): AgentsFile[] {
  const root = boundary === "git-root" ? findGitRoot(cwd) : undefined
  const files: AgentsFile[] = []
  const seen = new Set<string>()
  let dir = resolve(cwd)
  while (true) {
    for (const name of CONTEXT_CANDIDATES) {
      const path = join(dir, name)
      // Windows 大小写不敏感，AGENTS.md 与 AGENTS.MD 指向同一文件，须按小写去重。
      const key = path.toLowerCase()
      if (existsSync(path) && !seen.has(key)) {
        seen.add(key)
        files.unshift({ path, content: readFileSync(path, "utf8") })
      }
    }
    if (root && dir === root) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return files
}

/**
 * 收集项目路径下的 skill 目录（<cwd>/.pi/skills 与祖先目录的 .agents/skills）。
 * 与 pi 一致：.agents/skills 始终在 git 根停下（无 git 时到文件系统根），
 * 因此两档边界在 skills 上的行为一致，边界只作用于 AGENTS.md。
 */
export function loadProjectSkillPaths(cwd: string, _boundary: ProjectBoundary): string[] {
  const resolvedCwd = resolve(cwd)
  const root = findGitRoot(resolvedCwd)
  const paths: string[] = []
  const piSkills = join(resolvedCwd, ".pi", "skills")
  if (existsSync(piSkills)) paths.push(piSkills)
  let dir = resolvedCwd
  while (true) {
    const agentsSkills = join(dir, ".agents", "skills")
    if (existsSync(agentsSkills)) paths.push(agentsSkills)
    if (root && dir === root) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return paths
}
