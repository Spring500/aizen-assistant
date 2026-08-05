import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import type { ProjectSources } from "./view-config.ts"

/**
 * 项目路径资源发现。AA 自管全部项目层加载（pi 的 noContextFiles / noSkills
 * 保持关闭），因此这里的加载范围由我们控制：
 * - "cwd"：只加载当前工作目录；
 * - "git-root"：AGENTS.md 到 git 根；skills 到 git 根（无 git 时到文件系统根）；
 * - "pi-default"：AGENTS.md 冒泡到文件系统根；skills 与 git-root 一致。
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
    if (boundary === "cwd" || (root && dir === root)) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return files
}

/**
 * 收集项目路径下的 skill 目录（<cwd>/.pi/skills 与祖先目录的 .agents/skills）。
 * "cwd" 只读当前工作目录；pi-default 与 git-root 在 skills 上均到 git 根
 * （无 git 时到文件系统根），边界只作用于 AGENTS.md 与是否读上级目录。
 */
export function loadProjectSkillPaths(cwd: string, boundary: ProjectBoundary): string[] {
  const resolvedCwd = resolve(cwd)
  const root = findGitRoot(resolvedCwd)
  const paths: string[] = []
  const piSkills = join(resolvedCwd, ".pi", "skills")
  if (existsSync(piSkills)) paths.push(piSkills)
  let dir = resolvedCwd
  while (true) {
    const agentsSkills = join(dir, ".agents", "skills")
    if (existsSync(agentsSkills)) paths.push(agentsSkills)
    if (boundary === "cwd" || (root && dir === root)) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return paths
}
