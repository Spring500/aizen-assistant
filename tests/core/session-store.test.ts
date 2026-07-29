import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MnemonicIdGenerator } from "../../packages/core/mnemonic-id.ts"
import { sessionFileName } from "../../packages/core/session-file-name.ts"
import { SessionStore } from "../../packages/core/session-store.ts"

const temporaryDirectories: string[] = []

async function makeStore(indexed = false): Promise<{ root: string; store: SessionStore; indexPath?: string }> {
  const root = await mkdtemp(join(tmpdir(), "aizen-session-"))
  temporaryDirectories.push(root)
  const indexPath = indexed ? join(root, "..", `${root.split(/[\\/]/).at(-1)}-cache`, "session-index.json") : undefined
  if (indexPath) temporaryDirectories.push(join(indexPath, ".."))
  return {
    root,
    store: new SessionStore(root, indexPath ? { indexPath } : {}),
    ...(indexPath ? { indexPath } : {}),
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("会话存储", () => {
  test("排他新建并按调用顺序追加", async () => {
    const { root, store } = await makeStore()
    const createdAt = "2026-07-23T10:00:00.000Z"
    const header = await store.create({ sessionId: "s1", cwd: "E:\\project", createdAt })
    expect(await readdir(root)).toEqual([sessionFileName(createdAt, "s1")])
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

  test("重写使用原子替换并拒绝覆盖外部追加", async () => {
    const { root, store } = await makeStore()
    const createdAt = "2026-07-23T10:00:00.000Z"
    await store.create({ sessionId: "s1", cwd: "E:\\project", createdAt })
    const first = {
      kind: "session_renamed" as const,
      recordId: "r1",
      at: "2026-07-23T10:00:01.000Z",
      name: "第一版",
    }
    await store.append("s1", first)
    await store.rewrite("s1", [first], [{ ...first, recordId: "r2", name: "第二版" }])
    expect((await store.read("s1")).records).toEqual([{ ...first, recordId: "r2", name: "第二版" }])

    const expected = (await store.read("s1")).records
    const file = join(root, sessionFileName(createdAt, "s1"))
    await appendFile(
      file,
      `${JSON.stringify({ kind: "session_renamed", recordId: "external", at: new Date().toISOString(), name: "外部" })}\n`,
    )
    await expect(store.rewrite("s1", expected, [])).rejects.toThrow("已被其他程序修改")
    expect((await store.read("s1")).records.at(-1)).toMatchObject({ recordId: "external" })
  })

  test("生成 ID 和创建位于同一个排他事务", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-session-"))
    temporaryDirectories.push(root)
    let sequence = 0
    const idGenerator: MnemonicIdGenerator = {
      generate(exists) {
        for (const candidate of ["shared-id", `fallback-${sequence++}`]) if (!exists(candidate)) return candidate
        throw new Error("无法生成 ID")
      },
    }
    const first = new SessionStore(root, { idGenerator })
    const second = new SessionStore(root, { idGenerator })
    const [left, right] = await Promise.all([
      first.createGenerated({ cwd: "E:\\project", createdAt: "2026-07-23T10:00:00.000Z" }, []),
      second.createGenerated({ cwd: "E:\\project", createdAt: "2026-07-23T10:00:01.000Z" }, []),
    ])
    expect(left.sessionId).not.toBe(right.sessionId)
    expect((await first.list()).map((session) => session.sessionId).sort()).toEqual(
      [left.sessionId, right.sessionId].sort(),
    )
  })

  test("新会话使用助记词 ID 并避开已有会话", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-session-"))
    temporaryDirectories.push(root)
    const candidates = ["existing-session-id", "otter-builds-bridge"]
    const idGenerator: MnemonicIdGenerator = {
      generate(exists) {
        return candidates.find((candidate) => !exists(candidate)) ?? "fallback-id"
      },
    }
    const store = new SessionStore(root, { idGenerator })
    await store.create({
      sessionId: "existing-session-id",
      cwd: "E:\\project",
      createdAt: "2026-07-23T10:00:00.000Z",
    })

    expect(await store.suggestId()).toBe("otter-builds-bridge")
  })

  test("文件名不参与会话识别，外部改名后仍可读取和追加", async () => {
    const { root, store } = await makeStore()
    const createdAt = "2026-07-23T10:00:00.000Z"
    await store.create({ sessionId: "s1", cwd: "E:\\project", createdAt })
    await rename(join(root, sessionFileName(createdAt, "s1")), join(root, "用户任意命名.jsonl"))

    const reopened = new SessionStore(root)
    expect((await reopened.list())[0]?.sessionId).toBe("s1")
    await reopened.append("s1", {
      kind: "session_renamed",
      recordId: "r1",
      at: "2026-07-23T10:01:00.000Z",
      name: "外部改名后",
    })
    expect((await reopened.read("s1")).records).toHaveLength(1)
  })

  test("重复会话 ID 会明确报错", async () => {
    const { root, store } = await makeStore()
    const createdAt = "2026-07-23T10:00:00.000Z"
    await store.create({ sessionId: "s1", cwd: "E:\\project", createdAt })
    await writeFile(
      join(root, "复制文件.jsonl"),
      `${JSON.stringify({ kind: "session", version: 1, sessionId: "s1", cwd: "E:\\project", createdAt })}\n`,
    )
    await expect(store.list()).rejects.toThrow("重复的会话 ID")
  })

  test("列表读取名称和第一条用户输入并按更新时间倒序", async () => {
    const { store } = await makeStore()
    for (const [sessionId, text] of [
      ["s1", "第一项"],
      ["s2", "第二项"],
    ] as const) {
      await store.create({ sessionId, cwd: "E:\\project", createdAt: "2026-07-23T10:00:00.000Z" })
      if (sessionId === "s2")
        await store.append(sessionId, {
          kind: "session_renamed",
          recordId: `${sessionId}-name`,
          at: "2026-07-23T10:00:00.500Z",
          name: "第二个会话",
        })
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
    expect(listed[0]).toMatchObject({ name: "第二个会话", preview: "第二项" })
    expect(listed[1]?.name).toBe("")
  })

  test("单文件摘要缓存可丢弃并随会话增删改自动修复", async () => {
    const { root, store, indexPath } = await makeStore(true)
    if (!indexPath) throw new Error("缺少测试索引路径")
    await store.create({ sessionId: "s1", cwd: "E:\\project", createdAt: "2026-07-23T10:00:00.000Z" })
    await store.append("s1", {
      kind: "turn_started",
      recordId: "r1",
      turnId: "t1",
      at: "2026-07-23T10:00:01.000Z",
      viewId: null,
      items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "初始预览" }] }],
    })
    expect((await store.list())[0]?.preview).toBe("初始预览")
    expect(JSON.parse(await readFile(indexPath, "utf8"))).toMatchObject({ version: 1 })

    await writeFile(indexPath, "损坏缓存")
    expect((await store.list())[0]?.preview).toBe("初始预览")
    await writeFile(indexPath, JSON.stringify({ version: 1, projects: { broken: { s1: {} } } }))
    expect((await store.list())[0]?.preview).toBe("初始预览")

    await store.append("s1", { kind: "session_renamed", recordId: "r2", at: new Date().toISOString(), name: "新名称" })
    expect((await store.list())[0]?.name).toBe("新名称")

    await rm(join(root, sessionFileName("2026-07-23T10:00:00.000Z", "s1")))
    expect(await store.list()).toEqual([])
    const repaired = JSON.parse(await readFile(indexPath, "utf8"))
    expect(Object.values(repaired.projects)[0]).toEqual({})
  })

  test("忽略损坏尾行并拒绝损坏中间行", async () => {
    const { root, store } = await makeStore()
    const createdAt = "2026-07-23T10:00:00.000Z"
    await store.create({ sessionId: "s1", cwd: "E:\\project", createdAt })
    const file = join(root, sessionFileName(createdAt, "s1"))
    await appendFile(file, '{"kind":"turn_started"')
    const tailDamaged = await store.read("s1")
    expect(tailDamaged.warnings).toHaveLength(1)

    const originalHeader = (await readFile(file, "utf8")).split("\n")[0]
    await writeFile(file, `${originalHeader}\nnot-json\n{"kind":"turn_finished"}`)
    await expect(store.read("s1")).rejects.toThrow("第 2 行")
  })
})
