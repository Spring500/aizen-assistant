import { afterEach, describe, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { appendFile, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MnemonicIdGenerator } from "../../packages/core/mnemonic-id.ts"
import { sessionFileName } from "../../packages/core/session-file-name.ts"
import { SessionLockedError, SessionStore } from "../../packages/core/session-store.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const temporaryDirectories: string[] = []

function incompatibleSession(sessionId = "incompatible"): string {
  return [
    JSON.stringify({
      kind: "session",
      version: 1,
      sessionId,
      cwd: "E:\\project",
      createdAt: "2026-07-23T10:00:00.000Z",
    }),
    JSON.stringify({
      kind: "model_changed",
      recordId: "model",
      at: "2026-07-23T10:00:00.000Z",
      model: { providerId: "test", modelId: "test" },
    }),
    JSON.stringify({
      kind: "view_changed",
      recordId: "view",
      at: "2026-07-23T10:00:00.000Z",
      viewId: null,
    }),
    JSON.stringify({ kind: "permission_mode_changed", permissionMode: "unrestricted" }),
    "",
  ].join("\n")
}

class LeaseRacingStore extends SessionStore {
  afterNextList: (() => Promise<void>) | undefined

  override async list() {
    const summaries = await super.list()
    const afterList = this.afterNextList
    this.afterNextList = undefined
    if (afterList) await afterList()
    return summaries
  }
}

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
  test("会话租约阻止第二个实例打开并在释放后恢复", async () => {
    const { root } = await makeStore()
    const first = new SessionStore(root)
    const second = new SessionStore(root)
    await first.create({ sessionId: "s1", cwd: "E:\\project", createdAt: "2026-07-23T10:00:00.000Z" })
    await first.open("s1")

    expect((await first.list())[0]?.lockState).toBe("current")
    expect((await second.list())[0]?.lockState).toBe("occupied")
    await expect(second.open("s1")).rejects.toBeInstanceOf(SessionLockedError)
    await first.close()
    await expect(second.open("s1")).resolves.toBeDefined()
    expect((await second.list())[0]?.lockState).toBe("current")
    await second.close()
  })

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
        model: { providerId: "p", modelId: "m", thinkingLevel: "off" },
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

  test("重复会话 ID 只保留一个会话", async () => {
    const { root, store } = await makeStore()
    const createdAt = "2026-07-23T10:00:00.000Z"
    await store.create({ sessionId: "s1", cwd: "E:\\project", createdAt })
    await writeFile(
      join(root, "复制文件.jsonl"),
      `${JSON.stringify({ kind: "session", sessionId: "s1", cwd: "E:\\project", createdAt })}\n`,
    )
    const listed = await store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.sessionId).toBe("s1")
    expect(listed[0]?.capabilities.canOpen).toBe(true)
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

  test("不兼容条目不会阻断健康会话或新建会话", async () => {
    const { root, store } = await makeStore()
    await store.create({ sessionId: "healthy", cwd: "E:\\project", createdAt: "2026-07-23T10:00:00.000Z" })
    const incompatible = join(root, "incompatible.jsonl")
    await writeFile(incompatible, incompatibleSession())

    const listed = await store.list()
    const bad = listed.find((entry) => entry.sessionId === "incompatible")
    expect(bad?.issues.map((issue) => issue.code)).toEqual(["session.incompatible_record"])
    expect(bad?.capabilities).toMatchObject({ canOpen: true, canForceOpen: true })
    expect(await store.open("healthy")).toBeDefined()
    await store.close("healthy")
    await expect(store.open("incompatible")).resolves.toBeDefined()
    await store.close("incompatible")
    await expect(
      store.create({ sessionId: "new-session", cwd: "E:\\project", createdAt: "2026-07-23T10:01:00.000Z" }),
    ).resolves.toBeDefined()
  })

  test("不兼容会话被占用时同时返回不兼容与使用中问题并禁止打开", async () => {
    const { root } = await makeStore()
    await writeFile(join(root, "incompatible.jsonl"), incompatibleSession())
    const first = new SessionStore(root)
    const second = new SessionStore(root)

    await first.open("incompatible")
    await first.activate("incompatible")
    const listed = (await second.list())[0]
    expect(listed?.lockState).toBe("occupied")
    expect(listed?.issues.map((issue) => issue.code)).toEqual(["session.incompatible_record", "session.in_use"])
    expect(listed?.capabilities).toEqual({ canOpen: false, canForceOpen: false })
    await first.close()
  })

  test("不兼容且内容损坏的会话被占用时仍返回使用中问题", async () => {
    const { root } = await makeStore()
    const createdAt = "2026-07-23T10:00:00.000Z"
    const sessionId = "occupied-damaged"
    const first = new SessionStore(root)
    const second = new SessionStore(root)
    await first.create({ sessionId, cwd: "E:\\project", createdAt })
    await first.open(sessionId)
    await first.activate(sessionId)

    try {
      await appendFile(
        join(root, sessionFileName(createdAt, sessionId)),
        `${JSON.stringify({
          kind: "permission_mode_changed",
          recordId: "incompatible-permission",
          at: "2026-07-23T10:01:00.000Z",
          permissionMode: "unrestricted",
        })}\n${JSON.stringify({
          kind: "session_renamed",
          recordId: "invalid-rename",
          at: "2026-07-23T10:02:00.000Z",
        })}\n`,
      )

      const listed = (await second.list())[0]
      expect(listed?.issues.map((issue) => issue.code)).toEqual([
        "session.incompatible_record",
        "session.record_validation_failed",
        "session.in_use",
      ])
      expect(listed?.lockState).toBe("occupied")
      expect(listed?.capabilities).toEqual({ canOpen: false, canForceOpen: false })
    } finally {
      await first.close()
    }
  })

  test("打开在列表后租约被抢占时返回占用错误", async () => {
    const { root } = await makeStore()
    await writeFile(join(root, "incompatible.jsonl"), incompatibleSession())
    const racing = new LeaseRacingStore(root)
    const competing = new SessionStore(root)
    racing.afterNextList = async () => {
      await competing.open("incompatible")
      await competing.activate("incompatible")
    }

    await expect(racing.open("incompatible")).rejects.toBeInstanceOf(SessionLockedError)
    await competing.close()
  })

  test("打开不兼容会话后原条目保持不兼容标记并再次可打开", async () => {
    const { root, store } = await makeStore()
    await writeFile(join(root, "incompatible.jsonl"), incompatibleSession())

    await store.open("incompatible")
    await store.activate("incompatible")
    const current = (await store.list())[0]
    expect(current?.lockState).toBe("current")
    expect(current?.issues.map((issue) => issue.code)).toEqual(["session.incompatible_record"])
    expect(current?.capabilities).toEqual({ canOpen: true, canForceOpen: true })
    await store.close()
  })

  test("内容损坏和字段损坏均不能打开", async () => {
    const { root, store } = await makeStore()
    const createdAt = "2026-07-23T10:00:00.000Z"
    const header = (sessionId: string) => JSON.stringify({ kind: "session", sessionId, cwd: "E:\\project", createdAt })
    await writeFile(join(root, "invalid-json.jsonl"), `${header("invalid-json")}\nnot-json\n`)
    await writeFile(
      join(root, "invalid-record.jsonl"),
      `${header("invalid-record")}\n${JSON.stringify({ kind: "model_changed", recordId: "model" })}\n`,
    )

    const listed = await store.list()
    for (const entry of listed) expect(entry.capabilities.canOpen).toBe(false)
    expect(listed.find((entry) => entry.sessionId === "invalid-json")?.issues[0]?.code).toBe("session.invalid_json")
    expect(listed.find((entry) => entry.sessionId === "invalid-record")?.issues[0]?.code).toBe(
      "session.record_validation_failed",
    )
  })

  test("携带历史 permissionMode 字段的会话正常打开而不判为损坏", async () => {
    const { root, store } = await makeStore()
    const createdAt = "2026-07-23T10:00:00.000Z"
    const sessionId = "legacy-permission"
    await writeFile(
      join(root, sessionFileName(createdAt, sessionId)),
      [
        JSON.stringify({ kind: "session", sessionId, cwd: "E:\\project", createdAt }),
        JSON.stringify({
          kind: "turn_started",
          recordId: "started",
          turnId: "turn-1",
          at: "2026-07-23T10:00:02.000Z",
          viewId: null,
          permissionMode: "hybrid",
          items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "你好" }] }],
        }),
        JSON.stringify({
          kind: "turn_finished",
          recordId: "finished",
          turnId: "turn-1",
          at: "2026-07-23T10:00:03.000Z",
          outcome: "completed",
        }),
        "",
      ].join("\n"),
    )

    const listed = await store.list()
    const legacy = listed.find((entry) => entry.sessionId === sessionId)
    expect(legacy?.issues).toEqual([])
    expect(legacy?.capabilities).toEqual({ canOpen: true, canForceOpen: false })
    await expect(store.open(sessionId)).resolves.toBeDefined()
    await store.close(sessionId)
  })

  test("语法损坏与不完整尾行返回不同问题和操作能力", async () => {
    const { root, store } = await makeStore()
    const header = JSON.stringify({
      kind: "session",
      version: 1,
      sessionId: "damaged",
      cwd: "E:\\project",
      createdAt: "2026-07-23T10:00:00.000Z",
    })
    await writeFile(join(root, "damaged.jsonl"), `${header}\nnot-json\n`)
    await writeFile(join(root, "incomplete.jsonl"), `${header.replace("damaged", "incomplete")}\n{`)

    const listed = await store.list()
    expect(listed.find((entry) => entry.sessionId === "damaged")?.issues[0]?.code).toBe("session.invalid_json")
    const incomplete = listed.find((entry) => entry.sessionId === "incomplete")
    expect(incomplete?.issues[0]?.code).toBe("session.incomplete_tail")
    expect(incomplete?.capabilities.canOpen).toBe(true)
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
    expect(JSON.parse(await readFile(indexPath, "utf8"))).not.toHaveProperty("version")

    await writeFile(indexPath, "损坏缓存")
    expect((await store.list())[0]?.preview).toBe("初始预览")
    await writeFile(indexPath, JSON.stringify({ projects: { broken: { s1: {} } } }))
    expect((await store.list())[0]?.preview).toBe("初始预览")

    await store.append("s1", { kind: "session_renamed", recordId: "r2", at: new Date().toISOString(), name: "新名称" })
    expect((await store.list())[0]?.name).toBe("新名称")

    await rm(join(root, sessionFileName("2026-07-23T10:00:00.000Z", "s1")))
    expect(await store.list()).toEqual([])
    const repaired = JSON.parse(await readFile(indexPath, "utf8"))
    expect(Object.values(repaired.projects)[0]).toEqual({})
  })

  test("同版本缓存含过期打开能力时重新检查文件", async () => {
    const { root, store, indexPath } = await makeStore(true)
    if (!indexPath) throw new Error("缺少测试索引路径")
    const createdAt = "2026-07-23T10:00:00.000Z"
    const sessionId = "cached-incompatible"
    const file = join(root, sessionFileName(createdAt, sessionId))
    await writeFile(
      file,
      [
        JSON.stringify({ kind: "session", sessionId, cwd: "E:\\project", createdAt }),
        JSON.stringify({
          kind: "model_changed",
          recordId: "m1",
          at: "2026-07-23T10:00:01.000Z",
          model: { providerId: "x", modelId: "y" },
        }),
        JSON.stringify({ kind: "view_changed", recordId: "v1", at: "2026-07-23T10:00:01.000Z", viewId: null }),
        JSON.stringify({
          kind: "permission_mode_changed",
          recordId: "p1",
          at: "2026-07-23T10:00:01.500Z",
          permissionMode: "hybrid",
        }),
        "",
      ].join("\n"),
    )
    const status = await stat(file)
    const projectKey = root.split(/[\\/]/).at(-1) ?? ""
    await store.list()
    await writeFile(
      indexPath,
      JSON.stringify({
        projects: {
          [projectKey]: {
            [sessionFileName(createdAt, sessionId)]: {
              size: status.size,
              birthtimeMs: status.birthtimeMs,
              mtimeMs: status.mtimeMs,
              summary: {
                sessionId,
                name: "",
                cwd: "E:\\project",
                createdAt,
                updatedAt: createdAt,
                preview: "新会话",
                issues: [{ code: "session.incompatible_record", label: "不兼容", message: "旧判定" }],
                capabilities: { canOpen: false, canForceOpen: true },
              },
            },
          },
        },
      }),
    )

    const listed = await store.list()
    const current = listed.find((entry) => entry.sessionId === sessionId)
    expect(current?.capabilities.canOpen).toBe(true)
    expect(current?.issues[0]?.message).not.toBe("旧判定")
  })

  test("忽略损坏尾行并拒绝损坏中间行", async () => {
    const { root, store } = await makeStore()
    const createdAt = "2026-07-23T10:00:00.000Z"
    await store.create({ sessionId: "s1", cwd: "E:\\project", createdAt })
    const file = join(root, sessionFileName(createdAt, "s1"))
    await appendFile(file, '{"kind":"turn_started"')
    const tailDamaged = await store.read("s1")
    expect(tailDamaged.warnings).toHaveLength(1)

    await store.append("s1", {
      kind: "session_renamed",
      recordId: "after-repair",
      at: "2026-07-23T10:01:00.000Z",
      name: "已修复",
    })
    expect((await store.read("s1")).records.map((record) => record.recordId)).toEqual(["after-repair"])
    expect(await readFile(file, "utf8")).not.toContain('{"kind":"turn_started"')

    const originalHeader = (await readFile(file, "utf8")).split("\n")[0]
    await writeFile(file, `${originalHeader}\nnot-json\n{"kind":"turn_finished"}`)
    await expect(store.read("s1")).rejects.toThrow("第 2 行")
  })

  test("追加时保留合法但没有末尾换行的最后一条记录", async () => {
    const { root, store } = await makeStore()
    const createdAt = "2026-07-23T10:00:00.000Z"
    await store.create({ sessionId: "s1", cwd: "E:\\project", createdAt })
    const file = join(root, sessionFileName(createdAt, "s1"))
    const first = {
      kind: "session_renamed" as const,
      recordId: "first",
      at: "2026-07-23T10:00:01.000Z",
      name: "第一条",
    }
    await appendFile(file, JSON.stringify(first))

    await store.append("s1", {
      kind: "session_renamed",
      recordId: "second",
      at: "2026-07-23T10:00:02.000Z",
      name: "第二条",
    })
    expect((await store.read("s1")).records.map((record) => record.recordId)).toEqual(["first", "second"])
    expect(await readFile(file, "utf8")).toContain(`${JSON.stringify(first)}\n`)
  })
})
