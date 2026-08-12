import { afterEach, describe, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseSkillsValue, SkillStore } from "../../packages/core/skill-store.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

/** 注入替身拉取：把固定的仓库结构写到缓存目录，模拟一次成功的 git 拉取。 */
async function fakeFetch(cacheDir: string, _url: string, _ref?: string): Promise<void> {
  await mkdir(join(cacheDir, "skills", "http"), { recursive: true })
  await writeFile(join(cacheDir, "skills", "http", "SKILL.md"), "---\nname: http\ndescription: HTTP 技能\n---\n")
}

async function temporaryStore() {
  const root = await mkdtemp(join(tmpdir(), "aizen-skills-"))
  directories.push(root)
  const store = new SkillStore({
    file: join(root, "skills.json"),
    cacheDirectory: join(root, "cache"),
    fetchRepo: fakeFetch,
  })
  return { root, store }
}

describe("skill 登记表", () => {
  test("严格校验字段", () => {
    expect(() => parseSkillsValue({ skills: [{ name: "x" }] })).toThrow("sourceUrl")
    expect(() => parseSkillsValue({ skills: [{ name: "x", sourceUrl: "u", relPath: "r", extra: true }] })).toThrow(
      "未知字段",
    )
    expect(
      parseSkillsValue({
        skills: [{ name: "x", sourceUrl: "u", relPath: "r" }],
      }).skills[0],
    ).toEqual({ name: "x", sourceUrl: "u", relPath: "r" })
  })

  test("引入仓库并扫描出其中的 skill", async () => {
    const { store } = await temporaryStore()
    const discovered = await store.discoverSource("https://gitlab.com/team/skills.git", "main")
    expect(discovered).toEqual([{ name: "http", description: "HTTP 技能", relPath: "skills/http" }])
    expect((await store.list()).entries).toEqual([])
  })

  test("安装、同名冲突、替换与卸载", async () => {
    const { root, store } = await temporaryStore()
    const installed = await store.installSkill({
      name: "http",
      sourceUrl: "https://gitlab.com/team/skills.git",
      ref: "main",
      relPath: "skills/http",
    })
    expect("installed" in installed && installed.installed.name).toBe("http")
    expect(await store.hasName("http")).toBe(true)

    const conflict = await store.installSkill({
      name: "http",
      sourceUrl: "https://example.com/other.git",
      relPath: "http",
    })
    expect("conflict" in conflict).toBe(true)

    await store.replaceSkill("http", { sourceUrl: "https://example.com/other.git", relPath: "http" })
    const replaced = (await store.list()).entries
    expect(replaced[0]).toMatchObject({ name: "http", sourceUrl: "https://example.com/other.git", relPath: "http" })

    await store.removeSkill("http")
    expect((await store.list()).entries).toEqual([])
    const persisted = JSON.parse(await readFile(join(root, "skills.json"), "utf8"))
    expect(persisted.skills).toEqual([])
  })

  test("解析用户层可挂载路径，缺失的缓存目录被单独报告", async () => {
    const { root, store } = await temporaryStore()
    await store.installSkill({
      name: "http",
      sourceUrl: "https://gitlab.com/team/skills.git",
      ref: "main",
      relPath: "skills/http",
    })
    await store.discoverSource("https://gitlab.com/team/skills.git", "main")
    const ready = await store.resolveUserSkills()
    expect(ready.missing).toEqual([])
    expect(ready.paths[0]?.replaceAll("\\", "/").endsWith("skills/http")).toBe(true)

    await rm(join(root, "cache"), { recursive: true, force: true })
    const missing = await store.resolveUserSkills()
    expect(missing.paths).toEqual([])
    expect(missing.missing).toEqual(["http"])
  })

  test("卸载最后一个引用后清理不再使用的缓存目录", async () => {
    const { store } = await temporaryStore()
    await store.installSkill({
      name: "http",
      sourceUrl: "https://gitlab.com/team/skills.git",
      relPath: "skills/http",
    })
    await store.discoverSource("https://gitlab.com/team/skills.git")
    await store.removeSkill("http")
    const result = await store.resolveUserSkills()
    expect(result.missing).toEqual([])
    expect(result.paths).toEqual([])
  })
})
