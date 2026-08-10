import { mkdir, open, readdir, readFile, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { acquireFileLock, atomicWriteFile, isFileLocked, withFileLock } from "./file-transaction.ts"
import { type MnemonicIdGenerator, WordTripletIdGenerator } from "./mnemonic-id.ts"
import { sessionFileName } from "./session-file-name.ts"
import {
  parseSessionValue,
  type SessionHeader,
  type SessionLine,
  type SessionRecord,
  type TurnStartedRecord,
} from "./session-format.ts"
import { type SessionIndexEntry, SessionIndexStore } from "./session-index-store.ts"

export type SessionLockState = "available" | "occupied" | "current"

export class SessionLockedError extends Error {
  readonly code = "SESSION_LOCKED"

  constructor(sessionId: string) {
    super(`会话正在被其他 Agent 使用：${sessionId}`)
  }
}

/** 待追加的记录本身不合法（区别于底层存储故障）。调用方可选择单条降级，不应锁死整个会话。 */
export class InvalidSessionRecordError extends Error {}

export type SessionSummary = {
  sessionId: string
  name: string
  cwd: string
  createdAt: string
  updatedAt: string
  preview: string
  lockState?: SessionLockState
}

export type LoadedSession = {
  header: SessionHeader
  records: SessionRecord[]
  warnings: string[]
}

function firstText(record: TurnStartedRecord): string | undefined {
  for (const item of record.items) {
    if (item.source !== "user") continue
    for (const part of item.parts) if (part.kind === "text" && part.text.trim()) return part.text.trim()
  }
  return undefined
}

function serializeSession(header: SessionHeader, records: SessionRecord[]): string {
  const validated = records.map((record) => {
    const line = parseSessionValue(record)
    if (line.kind === "session") throw new Error("会话记录中不能包含文件头")
    return line
  })
  return `${[header, ...validated].map((line) => JSON.stringify(line)).join("\n")}\n`
}

export class SessionStore {
  readonly root: string
  readonly #queues = new Map<string, Promise<void>>()
  readonly #paths = new Map<string, string>()
  readonly #idGenerator: MnemonicIdGenerator
  readonly #index: SessionIndexStore | undefined
  readonly #projectKey: string
  readonly #leases = new Map<string, () => Promise<void>>()
  #currentSessionId: string | undefined
  #warnings: string[] = []

  constructor(root: string, options: { idGenerator?: MnemonicIdGenerator; indexPath?: string } = {}) {
    this.root = root
    this.#idGenerator = options.idGenerator ?? new WordTripletIdGenerator()
    this.#index = options.indexPath ? new SessionIndexStore(options.indexPath) : undefined
    this.#projectKey = basename(root)
  }

  /** 获取指定会话的长期租约；已持有时返回当前历史。 */
  async open(sessionId: string): Promise<LoadedSession> {
    if (this.#leases.has(sessionId)) return this.#readPath(await this.#sessionPath(sessionId))
    await this.#sessionPath(sessionId)
    let release: () => Promise<void>
    try {
      release = await acquireFileLock(this.#lockPath(sessionId), { retries: 0 })
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ELOCKED") throw new SessionLockedError(sessionId)
      throw error
    }
    try {
      const loaded = await this.#readPath(await this.#sessionPath(sessionId))
      this.#leases.set(sessionId, release)
      if (!this.#currentSessionId) this.#currentSessionId = sessionId
      return loaded
    } catch (error) {
      await release().catch(() => {})
      throw error
    }
  }

  /** 将已持有租约的会话设为当前会话，并释放其他会话租约。 */
  async activate(sessionId: string): Promise<void> {
    if (!this.#leases.has(sessionId)) throw new SessionLockedError(sessionId)
    for (const held of [...this.#leases.keys()]) if (held !== sessionId) await this.close(held)
    this.#currentSessionId = sessionId
  }

  /** 释放指定会话或当前会话租约。 */
  async close(sessionId?: string): Promise<void> {
    const target = sessionId ?? this.#currentSessionId
    if (!target) return
    const release = this.#leases.get(target)
    if (!release) return
    this.#leases.delete(target)
    if (this.#currentSessionId === target) this.#currentSessionId = undefined
    await release()
  }

  /** 返回不依赖 JSONL 文件名的稳定锁路径。 */
  #lockPath(sessionId: string): string {
    return join(this.root, `.${encodeURIComponent(sessionId)}.session`)
  }

  /** 用当前租约或一次性租约执行写操作。 */
  async #withWriteLease<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#leases.has(sessionId)) return operation()
    let release: () => Promise<void>
    try {
      release = await acquireFileLock(this.#lockPath(sessionId), { retries: 0 })
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ELOCKED") throw new SessionLockedError(sessionId)
      throw error
    }
    try {
      return await operation()
    } finally {
      await release()
    }
  }

  /** 释放当前实例持有的全部租约。 */
  async closeAll(): Promise<void> {
    for (const sessionId of [...this.#leases.keys()]) await this.close(sessionId)
  }

  /** 在创建事务内写入并获取新会话租约。 */
  async createGeneratedAndOpen(
    input: Omit<SessionHeader, "kind" | "version" | "sessionId">,
    records: SessionRecord[],
  ): Promise<SessionHeader> {
    await mkdir(this.root, { recursive: true })
    return withFileLock(join(this.root, ".sessions"), async () => {
      await this.#refreshPaths()
      const existing = new Set([...this.#paths.keys()].map((sessionId) => sessionId.toLowerCase()))
      const sessionId = this.#idGenerator.generate((candidate) => existing.has(candidate.toLowerCase()))
      const header = await this.#writeNewSession({ ...input, sessionId }, records)
      await this.open(sessionId)
      return header
    })
  }

  /** 生成一个不与现有会话冲突的助记词 ID。 */
  async suggestId(): Promise<string> {
    const existing = new Set((await this.list()).map((session) => session.sessionId.toLowerCase()))
    return this.#idGenerator.generate((candidate) => existing.has(candidate.toLowerCase()))
  }

  /** 原子创建包含完整初始记录的新会话。 */
  async createWithRecords(
    input: Omit<SessionHeader, "kind" | "version">,
    records: SessionRecord[],
  ): Promise<SessionHeader> {
    await mkdir(this.root, { recursive: true })
    return withFileLock(join(this.root, ".sessions"), async () => {
      await this.#refreshPaths()
      if (this.#paths.has(input.sessionId)) throw new Error("会话 ID 已存在")
      return this.#writeNewSession(input, records)
    })
  }

  /** 在创建锁内生成唯一 ID 并原子创建会话。 */
  async createGenerated(
    input: Omit<SessionHeader, "kind" | "version" | "sessionId">,
    records: SessionRecord[],
  ): Promise<SessionHeader> {
    await mkdir(this.root, { recursive: true })
    return withFileLock(join(this.root, ".sessions"), async () => {
      await this.#refreshPaths()
      const existing = new Set([...this.#paths.keys()].map((sessionId) => sessionId.toLowerCase()))
      const sessionId = this.#idGenerator.generate((candidate) => existing.has(candidate.toLowerCase()))
      return this.#writeNewSession({ ...input, sessionId }, records)
    })
  }

  async create(input: Omit<SessionHeader, "kind" | "version">): Promise<SessionHeader> {
    return this.createWithRecords(input, [])
  }

  async #writeNewSession(
    input: Omit<SessionHeader, "kind" | "version">,
    records: SessionRecord[],
  ): Promise<SessionHeader> {
    const path = join(this.root, sessionFileName(input.createdAt, input.sessionId))
    const header: SessionHeader = { kind: "session", version: 1, ...input }
    await atomicWriteFile(path, serializeSession(header, records))
    this.#paths.set(input.sessionId, path)
    return header
  }

  append(sessionId: string, record: SessionRecord): Promise<void> {
    let validated: SessionLine
    try {
      validated = parseSessionValue(record)
    } catch (error) {
      throw new InvalidSessionRecordError(error instanceof Error ? error.message : String(error))
    }
    if (validated.kind === "session") throw new Error("不能追加第二个会话文件头")
    return this.#enqueue(sessionId, () =>
      this.#withWriteLease(sessionId, async () => {
        const path = await this.#sessionPath(sessionId)
        const file = await open(path, "a")
        try {
          await file.writeFile(`${JSON.stringify(validated)}\n`)
          await file.sync()
        } finally {
          await file.close()
        }
      }),
    )
  }

  /** 在确认源记录未变化后，以原子替换方式重写会话。 */
  rewrite(sessionId: string, expectedRecords: SessionRecord[], records: SessionRecord[]): Promise<void> {
    return this.#enqueue(sessionId, () =>
      this.#withWriteLease(sessionId, async () => {
        const path = await this.#sessionPath(sessionId)
        const loaded = await this.#readPath(path)
        if (
          loaded.records.length !== expectedRecords.length ||
          loaded.records.some((record, index) => record.recordId !== expectedRecords[index]?.recordId)
        )
          throw new Error("会话已被其他程序修改，请重新打开后再试")
        await atomicWriteFile(path, serializeSession(loaded.header, records))
      }),
    )
  }

  async read(sessionId: string): Promise<LoadedSession> {
    await this.#queues.get(sessionId)
    return this.#readPath(await this.#sessionPath(sessionId))
  }

  async #readPath(path: string): Promise<LoadedSession> {
    const contents = await readFile(path, "utf8")
    const rawLines = contents.split("\n")
    if (rawLines.at(-1) === "") rawLines.pop()
    const lines: SessionLine[] = []
    const warnings: string[] = []
    for (const [index, rawLine] of rawLines.entries()) {
      try {
        lines.push(parseSessionValue(JSON.parse(rawLine)))
      } catch (error) {
        const isLast = index === rawLines.length - 1
        if (isLast && error instanceof SyntaxError) {
          warnings.push(`忽略不完整的最后一行（第 ${index + 1} 行）`)
          continue
        }
        throw new Error(`会话文件第 ${index + 1} 行无效：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const [header, ...records] = lines
    if (header?.kind !== "session") throw new Error("会话文件第一行不是文件头")
    if (records.some((record) => record.kind === "session")) throw new Error("会话文件只能有一个文件头")
    return { header, records: records as SessionRecord[], warnings }
  }

  async list(): Promise<SessionSummary[]> {
    await mkdir(this.root, { recursive: true })
    const previous = (await this.#index?.readProject(this.#projectKey)) ?? {}
    const current: Record<string, SessionIndexEntry> = {}
    const summaries: SessionSummary[] = []
    const paths = new Map<string, string>()
    const entries = await readdir(this.root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const path = join(this.root, entry.name)
      const fileStatus = await stat(path)
      const cached = previous[entry.name]
      const unchanged =
        cached?.size === fileStatus.size &&
        cached.birthtimeMs === fileStatus.birthtimeMs &&
        cached.mtimeMs === fileStatus.mtimeMs
      let summary: SessionSummary
      if (unchanged && cached) {
        summary = { ...cached.summary }
      } else {
        const loaded = await this.#readPath(path)
        const firstTurn = loaded.records.find((record): record is TurnStartedRecord => record.kind === "turn_started")
        const renamed = [...loaded.records].reverse().find((record) => record.kind === "session_renamed")
        summary = {
          sessionId: loaded.header.sessionId,
          name: renamed?.kind === "session_renamed" ? renamed.name : "",
          cwd: loaded.header.cwd,
          createdAt: loaded.header.createdAt,
          updatedAt: fileStatus.mtime.toISOString(),
          preview: firstTurn ? (firstText(firstTurn) ?? "新会话") : "新会话",
        }
      }
      if (paths.has(summary.sessionId)) throw new Error(`存在重复的会话 ID：${summary.sessionId}`)
      paths.set(summary.sessionId, path)
      current[entry.name] = {
        size: fileStatus.size,
        birthtimeMs: fileStatus.birthtimeMs,
        mtimeMs: fileStatus.mtimeMs,
        summary,
      }
      summaries.push(summary)
    }
    this.#paths.clear()
    for (const [sessionId, path] of paths) this.#paths.set(sessionId, path)
    const lockStates = await Promise.all(
      summaries.map(async (summary) => {
        const locked = await isFileLocked(this.#lockPath(summary.sessionId))
        return [
          summary.sessionId,
          locked ? (this.#currentSessionId === summary.sessionId ? "current" : "occupied") : "available",
        ] as const
      }),
    )
    const states = new Map(lockStates)
    for (const summary of summaries) summary.lockState = states.get(summary.sessionId) ?? "available"
    this.#warnings = this.#index ? await this.#index.updateProject(this.#projectKey, current) : []
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async #refreshPaths(): Promise<void> {
    const paths = new Map<string, string>()
    const entries = await readdir(this.root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const path = join(this.root, entry.name)
      const loaded = await this.#readPath(path)
      if (paths.has(loaded.header.sessionId)) throw new Error(`存在重复的会话 ID：${loaded.header.sessionId}`)
      paths.set(loaded.header.sessionId, path)
    }
    this.#paths.clear()
    for (const [sessionId, path] of paths) this.#paths.set(sessionId, path)
  }

  async #sessionPath(sessionId: string): Promise<string> {
    if (!sessionId) throw new Error("无效的会话 ID")
    const known = this.#paths.get(sessionId)
    if (known) return known
    await this.#refreshPaths()
    const path = this.#paths.get(sessionId)
    if (!path) throw new Error(`会话不存在：${sessionId}`)
    return path
  }

  #enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#queues.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.#queues.set(sessionId, next)
    void next.then(
      () => {
        if (this.#queues.get(sessionId) === next) this.#queues.delete(sessionId)
      },
      () => {
        if (this.#queues.get(sessionId) === next) this.#queues.delete(sessionId)
      },
    )
    return next
  }

  /** 取出最近一次列表操作产生的非阻断警告。 */
  takeWarnings(): string[] {
    return this.#warnings.splice(0)
  }

  async flush(): Promise<void> {
    await Promise.all(this.#queues.values())
    await this.closeAll()
  }
}
