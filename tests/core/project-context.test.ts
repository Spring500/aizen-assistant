import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findGitRoot, loadProjectAgentsFiles, loadProjectSkillPaths } from "../../packages/core/project-context.ts"

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
  test("git-root 边界把 AGENTS.md 限定到 git 根", async () => {
    const root = await temporaryDirectory()
    const repo = join(root, "repo")
    const inner = join(repo, "a", "b")
    await mkdir(join(repo, ".git"), { recursive: true })
    await mkdir(inner, { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "根规则")
    await writeFile(join(repo, "AGENTS.md"), "仓库规则")
    await writeFile(join(inner, "AGENTS.md"), "内层规则")

    expect(findGitRoot(inner)).toBe(repo)
    expect(loadProjectAgentsFiles(inner, "git-root").map((file) => file.content)).toEqual(["仓库规则", "内层规则"])
    expect(loadProjectAgentsFiles(inner, "pi-default").map((file) => file.content)).toEqual([
      "根规则",
      "仓库规则",
      "内层规则",
    ])
  })

  test("无 git 仓库时两档边界一致，冒泡到文件系统根", async () => {
    const root = await temporaryDirectory()
    const inner = join(root, "a", "b")
    await mkdir(inner, { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "根规则")
    await writeFile(join(inner, "AGENTS.md"), "内层规则")

    expect(findGitRoot(inner)).toBeNull()
    expect(loadProjectAgentsFiles(inner, "git-root").map((file) => file.content)).toEqual(["根规则", "内层规则"])
    expect(loadProjectAgentsFiles(inner, "pi-default").map((file) => file.content)).toEqual(["根规则", "内层规则"])
  })

  test("cwd 边界只读取当前工作目录", async () => {
    const root = await temporaryDirectory()
    const repo = join(root, "repo")
    const inner = join(repo, "a", "b")
    await mkdir(join(repo, ".git"), { recursive: true })
    await mkdir(inner, { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "根规则")
    await writeFile(join(repo, "AGENTS.md"), "仓库规则")
    await writeFile(join(inner, "AGENTS.md"), "内层规则")

    expect(loadProjectAgentsFiles(inner, "cwd").map((file) => file.content)).toEqual(["内层规则"])
    // skills 同样只读当前工作目录
    await mkdir(join(inner, ".pi", "skills"), { recursive: true })
    await mkdir(join(repo, ".agents", "skills"), { recursive: true })
    expect(loadProjectSkillPaths(inner, "cwd").map(toPosix)).toEqual([toPosix(join(inner, ".pi", "skills"))])
    expect(loadProjectSkillPaths(inner, "git-root").map(toPosix)).toEqual([
      toPosix(join(inner, ".pi", "skills")),
      toPosix(join(repo, ".agents", "skills")),
    ])
  })

  test("收集项目 skill 目录：cwd 的 .pi/skills 与祖先的 .agents/skills", async () => {
    const root = await temporaryDirectory()
    const repo = join(root, "repo")
    await mkdir(join(repo, ".git"), { recursive: true })
    await mkdir(join(repo, ".agents", "skills"), { recursive: true })
    const cwd = join(repo, "src")
    await mkdir(join(cwd, ".pi", "skills"), { recursive: true })

    expect(loadProjectSkillPaths(cwd, "git-root").map(toPosix)).toEqual([
      toPosix(join(cwd, ".pi", "skills")),
      toPosix(join(repo, ".agents", "skills")),
    ])
    // skills 的冒泡在 git 根停下，与边界选择无关
    expect(loadProjectSkillPaths(cwd, "pi-default")).toEqual(loadProjectSkillPaths(cwd, "git-root"))
  })
})
