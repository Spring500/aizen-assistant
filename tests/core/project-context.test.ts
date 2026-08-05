import { afterEach, describe, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findGitRoot, projectSourceBehaviors, resolveProjectSources } from "../../packages/core/project-context.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function temporaryDirectory() {
  const root = await mkdtemp(join(tmpdir(), "aizen-context-"))
  directories.push(root)
  return root
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/")
}

describe("项目路径资源", () => {
  test("git-root 行为把 AGENTS.md 限定到 git 根", async () => {
    const root = await temporaryDirectory()
    const repo = join(root, "repo")
    const inner = join(repo, "a", "b")
    await mkdir(join(repo, ".git"), { recursive: true })
    await mkdir(inner, { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "根规则")
    await writeFile(join(repo, "AGENTS.md"), "仓库规则")
    await writeFile(join(inner, "AGENTS.md"), "内层规则")

    expect(findGitRoot(inner)).toBe(repo)
    expect(resolveProjectSources(inner, "git-root").agentsFiles.map((file) => file.content)).toEqual([
      "仓库规则",
      "内层规则",
    ])
    expect(resolveProjectSources(inner, "pi-default").agentsFiles.map((file) => file.content)).toEqual([
      "根规则",
      "仓库规则",
      "内层规则",
    ])
  })

  test("无 git 仓库时 git-root 与 pi-default 一致，冒泡到文件系统根", async () => {
    const root = await temporaryDirectory()
    const inner = join(root, "a", "b")
    await mkdir(inner, { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "根规则")
    await writeFile(join(inner, "AGENTS.md"), "内层规则")

    expect(findGitRoot(inner)).toBeNull()
    expect(resolveProjectSources(inner, "git-root").agentsFiles.map((file) => file.content)).toEqual([
      "根规则",
      "内层规则",
    ])
    expect(resolveProjectSources(inner, "pi-default").agentsFiles.map((file) => file.content)).toEqual([
      "根规则",
      "内层规则",
    ])
  })

  test("cwd 行为只读取当前工作目录", async () => {
    const root = await temporaryDirectory()
    const repo = join(root, "repo")
    const inner = join(repo, "a", "b")
    await mkdir(join(repo, ".git"), { recursive: true })
    await mkdir(inner, { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "根规则")
    await writeFile(join(repo, "AGENTS.md"), "仓库规则")
    await writeFile(join(inner, "AGENTS.md"), "内层规则")

    expect(resolveProjectSources(inner, "cwd").agentsFiles.map((file) => file.content)).toEqual(["内层规则"])
    // skills 同样只读当前工作目录
    await mkdir(join(inner, ".pi", "skills"), { recursive: true })
    await mkdir(join(repo, ".agents", "skills"), { recursive: true })
    expect(resolveProjectSources(inner, "cwd").skillPaths.map(toPosix)).toEqual([toPosix(join(inner, ".pi", "skills"))])
    expect(resolveProjectSources(inner, "git-root").skillPaths.map(toPosix)).toEqual([
      toPosix(join(inner, ".pi", "skills")),
      toPosix(join(repo, ".agents", "skills")),
    ])
  })

  test("每级目录只取第一个命中的候选（AGENTS.md 优先于 CLAUDE.md）", async () => {
    const root = await temporaryDirectory()
    const inner = join(root, "a")
    await mkdir(inner, { recursive: true })
    await writeFile(join(inner, "AGENTS.md"), "AGENTS 规则")
    await writeFile(join(inner, "CLAUDE.md"), "CLAUDE 规则")

    expect(resolveProjectSources(inner, "cwd").agentsFiles.map((file) => file.content)).toEqual(["AGENTS 规则"])

    await rm(join(inner, "AGENTS.md"))
    expect(resolveProjectSources(inner, "cwd").agentsFiles.map((file) => file.content)).toEqual(["CLAUDE 规则"])
  })

  test("收集项目 skill 目录：cwd 的 .pi/skills 与祖先的 .agents/skills", async () => {
    const root = await temporaryDirectory()
    const repo = join(root, "repo")
    await mkdir(join(repo, ".git"), { recursive: true })
    await mkdir(join(repo, ".agents", "skills"), { recursive: true })
    const cwd = join(repo, "src")
    await mkdir(join(cwd, ".pi", "skills"), { recursive: true })

    expect(resolveProjectSources(cwd, "git-root").skillPaths.map(toPosix)).toEqual([
      toPosix(join(cwd, ".pi", "skills")),
      toPosix(join(repo, ".agents", "skills")),
    ])
    // skills 的冒泡在 git 根停下，与 pi-default 一致
    expect(resolveProjectSources(cwd, "pi-default").skillPaths).toEqual(
      resolveProjectSources(cwd, "git-root").skillPaths,
    )
  })

  test("行为注册表覆盖全部非 none 档位且可解析", async () => {
    expect(Object.keys(projectSourceBehaviors).sort()).toEqual(["cwd", "git-root", "pi-default"])
    const root = await temporaryDirectory()
    for (const boundary of Object.keys(projectSourceBehaviors) as Array<keyof typeof projectSourceBehaviors>) {
      const resolved = resolveProjectSources(root, boundary)
      expect(Array.isArray(resolved.agentsFiles)).toBe(true)
      expect(Array.isArray(resolved.skillPaths)).toBe(true)
    }
  })
})
