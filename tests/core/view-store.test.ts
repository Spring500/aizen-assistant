import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseViewsValue, ViewStore } from "../../packages/core/view-store.ts"

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function temporaryStore() {
  const root = await mkdtemp(join(tmpdir(), "aizen-views-"))
  directories.push(root)
  return { root, store: new ViewStore(join(root, "views.json")) }
}

describe("视图配置", () => {
  test("严格校验版本、字段和重复 ID", () => {
    expect(() => parseViewsValue({ version: 2, views: [] })).toThrow("版本")
    expect(() => parseViewsValue({ version: 1, views: [], extra: true })).toThrow("未知字段")
    expect(() =>
      parseViewsValue({
        version: 1,
        views: [
          { id: "dev", name: "开发", path: "views/dev" },
          { id: "dev", name: "开发二", path: "views/dev2" },
        ],
      }),
    ).toThrow("重复")
  })

  test("创建模板、列出并移除视图注册", async () => {
    const { root, store } = await temporaryStore()
    const created = await store.create({ id: "dev", name: "开发" })
    expect(created.directory).toBe(join(root, "views", "dev"))
    expect(await readFile(join(created.directory, "AGENTS.md"), "utf8")).toContain("视图说明")
    expect((await store.list())[0]).toMatchObject({ id: "dev", valid: true })
    await store.remove("dev")
    expect(await store.list()).toEqual([])
  })

  test("报告失效路径和配置错误", async () => {
    const { root, store } = await temporaryStore()
    await writeFile(
      join(root, "views.json"),
      JSON.stringify({ version: 1, views: [{ id: "gone", name: "失效", path: "missing" }] }),
    )
    expect((await store.list())[0]).toMatchObject({ id: "gone", valid: false })
    expect(store.resolve("gone")).rejects.toThrow("路径失效")
    await writeFile(join(root, "views.json"), "{")
    expect(store.list()).rejects.toThrow("配置错误")
  })
})
