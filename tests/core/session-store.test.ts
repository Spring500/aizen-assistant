import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "../../packages/core/session-store.ts"

const temporaryDirectories: string[] = []

async function makeStore(): Promise<{ root: string; store: SessionStore }> {
  const root = await mkdtemp(join(tmpdir(), "aizen-session-"))
  temporaryDirectories.push(root)
  return { root, store: new SessionStore(root) }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("会话存储", () => {
  test("排他新建并按调用顺序追加", async () => {
    const { store } = await makeStore()
    const header = await store.create({ sessionId: "s1", cwd: "E:\\project", createdAt: "2026-07-23T10:00:00.000Z" })
    expect(await readdir(store.sessionDirectory("s1"))).toEqual(["conversation.jsonl"])
    await expect(
      store.create({ sessionId: "s1", cwd: "E:\\project", createdAt: "2026-07-23T10:00:00.000Z" }),
    ).rejects.toThrow()

    await Promise.all([
      store.append("s1", {
        kind: "model_changed",
        recordId: "r1",
        at: "2026-07-23T10:00:01.000Z",
        model: { providerId: "p", modelId: "m", api: "a", thinkingLevel: "off" },
      }),
      store.append("s1", {
        kind: "view_changed",
        recordId: "r2",
        at: "2026-07-23T10:00:02.000Z",
        viewId: null,
      }),
    ])

    const loaded = await store.read("s1")
    expect(loaded.header).toEqual(header)
    expect(loaded.records.map((record) => record.recordId)).toEqual(["r1", "r2"])
  })

  test("列表读取第一条用户输入并按更新时间倒序", async () => {
    const { store } = await makeStore()
    for (const [sessionId, text] of [
      ["s1", "第一项"],
      ["s2", "第二项"],
    ] as const) {
      await store.create({ sessionId, cwd: "E:\\project", createdAt: "2026-07-23T10:00:00.000Z" })
      await store.append(sessionId, {
        kind: "turn_started",
        recordId: `${sessionId}-r1`,
        turnId: `${sessionId}-t1`,
        at: "2026-07-23T10:00:01.000Z",
        viewId: null,
        items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text }] }],
      })
      await Bun.sleep(10)
    }

    const listed = await store.list()
    expect(listed.map((item) => item.sessionId)).toEqual(["s2", "s1"])
    expect(listed[0]?.preview).toBe("第二项")
  })

  test("忽略损坏尾行并拒绝损坏中间行", async () => {
    const { root, store } = await makeStore()
    await store.create({ sessionId: "s1", cwd: "E:\\project", createdAt: "2026-07-23T10:00:00.000Z" })
    const file = join(root, "s1", "conversation.jsonl")
    await appendFile(file, '{"kind":"turn_started"')
    const tailDamaged = await store.read("s1")
    expect(tailDamaged.warnings).toHaveLength(1)

    const originalHeader = (await readFile(file, "utf8")).split("\n")[0]
    await writeFile(file, `${originalHeader}\nnot-json\n{"kind":"turn_finished"}`)
    await expect(store.read("s1")).rejects.toThrow("第 2 行")
  })
})
