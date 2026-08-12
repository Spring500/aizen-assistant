import { afterEach, describe, expect } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sessionFileName } from "../../packages/core/session-file-name.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import { SkillStore } from "../../packages/core/skill-store.ts"
import { ViewStore } from "../../packages/core/view-store.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { expectCatalogIsolation } from "../utils/catalog-isolation-contract.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function root(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

describe("目录型 Store 故障注入契约", () => {
  test("会话文件逐条隔离", async () => {
    const directory = await root("aizen-contract-session-")
    const store = new SessionStore(directory)
    await store.create({ sessionId: "healthy", cwd: directory, createdAt: "2026-01-01T00:00:00.000Z" })
    await writeFile(
      join(directory, "broken.jsonl"),
      `${JSON.stringify({ kind: "session", version: 1, sessionId: "broken", cwd: directory, createdAt: "2026-01-01T00:00:00.000Z" })}\n${JSON.stringify({ kind: "removed_record" })}\n`,
    )
    expectCatalogIsolation(await store.list(), sessionFileName("2026-01-01T00:00:00.000Z", "healthy"), "broken.jsonl")
    await expect(store.open("healthy")).resolves.toBeDefined()
    await store.close()
  })

  test("视图目录逐条隔离", async () => {
    const directory = await root("aizen-contract-view-")
    const store = new ViewStore(join(directory, "views.json"))
    await store.create({ id: "healthy", name: "健康" })
    await store.create({ id: "broken", name: "损坏" })
    await store.update("broken", { path: "missing" })
    expectCatalogIsolation(await store.list(), "healthy", "broken")
    await expect(store.resolve("healthy")).resolves.toBeDefined()
  })

  test("Skill 来源目录逐条隔离", async () => {
    const directory = await root("aizen-contract-skill-")
    const fetchRepo = async (cacheDirectory: string) => {
      await mkdir(join(cacheDirectory, "healthy"), { recursive: true })
      await writeFile(join(cacheDirectory, "healthy", "SKILL.md"), "---\nname: healthy\n---\n")
    }
    const store = new SkillStore({
      file: join(directory, "skills.json"),
      cacheDirectory: join(directory, "cache"),
      fetchRepo,
    })
    await store.discoverSource("https://example.com/healthy.git")
    await store.installSkill({ name: "healthy", sourceUrl: "https://example.com/healthy.git", relPath: "healthy" })
    await store.installSkill({ name: "broken", sourceUrl: "https://example.com/broken.git", relPath: "broken" })
    expectCatalogIsolation(await store.list(), "healthy", "broken")
    expect((await store.resolveUserSkills()).missing).toEqual(["broken"])
  })
})
