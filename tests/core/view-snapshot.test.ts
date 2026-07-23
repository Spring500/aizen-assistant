import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { saveEmptyViewSnapshot, snapshotViewDirectory } from "../../packages/core/view-snapshot.ts"

const temporaryDirectories: string[] = []

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aizen-view-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("视图副本", () => {
  test("空视图摘要稳定且相同内容不重复复制", async () => {
    const root = await makeTemporaryDirectory()
    const first = await saveEmptyViewSnapshot(join(root, "views"))
    const second = await saveEmptyViewSnapshot(join(root, "views"))

    expect(second).toEqual(first)
    expect(await readFile(join(first.directory, "view.json"), "utf8")).toContain('"id": "empty"')
  })

  test("文件创建顺序不影响摘要，内容变化产生新摘要", async () => {
    const root = await makeTemporaryDirectory()
    const firstView = join(root, "first")
    const secondView = join(root, "second")
    await mkdir(join(firstView, "skills", "review"), { recursive: true })
    await mkdir(join(secondView, "skills", "review"), { recursive: true })
    await writeFile(join(firstView, "view.json"), '{"id":"review"}')
    await writeFile(join(firstView, "AGENTS.md"), "规则")
    await writeFile(join(firstView, "skills", "review", "SKILL.md"), "技能")
    await writeFile(join(secondView, "skills", "review", "SKILL.md"), "技能")
    await writeFile(join(secondView, "AGENTS.md"), "规则")
    await writeFile(join(secondView, "view.json"), '{"id":"review"}')

    const first = await snapshotViewDirectory(firstView, join(root, "snapshots"))
    const second = await snapshotViewDirectory(secondView, join(root, "snapshots"))
    expect(second.contentHash).toBe(first.contentHash)

    await writeFile(join(secondView, "AGENTS.md"), "新规则")
    const changed = await snapshotViewDirectory(secondView, join(root, "snapshots"))
    expect(changed.contentHash).not.toBe(first.contentHash)
  })

  test("拒绝通过符号链接读取视图外文件", async () => {
    const root = await makeTemporaryDirectory()
    const view = join(root, "view")
    await mkdir(view)
    await writeFile(join(view, "view.json"), '{"id":"unsafe"}')
    await writeFile(join(root, "outside.md"), "外部内容")
    try {
      await symlink(join(root, "outside.md"), join(view, "AGENTS.md"))
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") return
      throw error
    }

    await expect(snapshotViewDirectory(view, join(root, "snapshots"))).rejects.toThrow("符号链接")
  })
})
