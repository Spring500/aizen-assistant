import type { Stats } from "node:fs"
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
  UnknownSessionRecordTypeError,
} from "./session-format.ts"
import { type SessionIndexEntry, SessionIndexStore } from "./session-index-store.ts"
import { type SessionIssue, sessionIssues } from "./session-issues.ts"

export type SessionLockState = "available" | "occupied" | "current"

export class SessionLockedError extends Error {
  readonly code = "SESSION_LOCKED"

  constructor(sessionId: string) {
    super(`会话正在被其他 Agent 使用：${sessionId}`)
  }
}

/** 待追加的记录本身不合法（区别于底层存储故障）。调用方可选择单条降级，不应锁死整个会话。 */
export class InvalidSessionRecordError extends Error {}

type SessionCapabilities = {
  canOpen: boolean
  canForceOpen: boolean
}

export type SessionSummary = {
  sessionId: string
  name: string
  cwd: string
  createdAt: string
  updatedAt: string
  preview: string
  issues: SessionIssue[]
  capabilities: SessionCapabilities
  lockState?: SessionLockState
}

export type LoadedSession = {
  header: SessionHeader
  records: SessionRecord[]
  warnings: string[]
  /** 未知记录类型的原始行（有效 JSON 但程序不认识），按文件顺序保留，避免重写时静默丢弃业务数据。 */
  unparsed?: Array<{ beforeRecord: number; line: string }>
}

type InspectedSession = {
  summary: SessionSummary
  loaded?: LoadedSession
}

function firstText(record: TurnStartedRecord): string | undefined {
  for (const item of record.items) {
    if (item.source !== "user") continue
    for (const part of item.parts) if (part.kind === "text" && part.text.trim()) return part.text.trim()
  }
  return undefined
}

function serializeSession(
  header: SessionHeader,
  records: SessionRecord[],
  unparsed: Array<{ beforeRecord: number; line: string }> = [],
): string {
  const lines: string[] = [JSON.stringify(header)]
  const unparsedByRecord = new Map<number, string[]>()
  for (const item of unparsed) {
    const bucket = unparsedByRecord.get(item.beforeRecord) ?? []
    bucket.push(item.line)
    unparsedByRecord.set(item.beforeRecord, bucket)
  }
  for (const [index, record] of records.entries()) {
    lines.push(...(unparsedByRecord.get(index) ?? []))
    const line = parseSessionValue(record)
    if (line.kind === "session") throw new Error("会话记录中不能包含文件头")
    lines.push(JSON.stringify(line))
  }
  lines.push(...(unparsedByRecord.get(records.length) ?? []))
  return `${lines.join("\n")}\n`
}

export class SessionStore {
  readonly root: string
  readonly #queues = new Map<string, Promise<void>>()
  readonly #paths = new Map<string, string>()
  readonly #idGenerator: MnemonicIdGenerator
  readonly #index: SessionIndexStore | undefined
  readonly #projectKey: string
  readonly #leases = new Map<string, () => Promise<void>>()
  readonly #knownSessionIds = new Set<string>()
  /** 已知但存在阻塞问题、无法打开的会话及其原因，用于打开失败时的准确报错。 */
  readonly #blockedReasons = new Map<string, string>()
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
    input: Omit<SessionHeader, "kind" | "sessionId">,
    records: SessionRecord[],
  ): Promise<SessionHeader> {
    await mkdir(this.root, { recursive: true })
    return withFileLock(join(this.root, ".sessions"), async () => {
      await this.#refreshPaths()
      const existing = new Set([...this.#knownSessionIds].map((sessionId) => sessionId.toLowerCase()))
      const sessionId = this.#idGenerator.generate((candidate) => existing.has(candidate.toLowerCase()))
      const header = await this.#writeNewSession({ ...input, sessionId }, records)
      await this.open(sessionId)
      return header
    })
  }

  /** 生成一个不与现有会话冲突的助记词 ID。 */
  async suggestId(): Promise<string> {
    await this.#refreshPaths()
    const existing = new Set([...this.#knownSessionIds].map((sessionId) => sessionId.toLowerCase()))
    return this.#idGenerator.generate((candidate) => existing.has(candidate.toLowerCase()))
  }

  /** 原子创建包含完整初始记录的新会话。 */
  async createWithRecords(input: Omit<SessionHeader, "kind">, records: SessionRecord[]): Promise<SessionHeader> {
    await mkdir(this.root, { recursive: true })
    return withFileLock(join(this.root, ".sessions"), async () => {
      await this.#refreshPaths()
      if (this.#knownSessionIds.has(input.sessionId)) throw new Error("会话 ID 已存在")
      return this.#writeNewSession(input, records)
    })
  }

  /** 在创建锁内生成唯一 ID 并原子创建会话。 */
  async createGenerated(
    input: Omit<SessionHeader, "kind" | "sessionId">,
    records: SessionRecord[],
  ): Promise<SessionHeader> {
    await mkdir(this.root, { recursive: true })
    return withFileLock(join(this.root, ".sessions"), async () => {
      await this.#refreshPaths()
      const existing = new Set([...this.#knownSessionIds].map((sessionId) => sessionId.toLowerCase()))
      const sessionId = this.#idGenerator.generate((candidate) => existing.has(candidate.toLowerCase()))
      return this.#writeNewSession({ ...input, sessionId }, records)
    })
  }

  async create(input: Omit<SessionHeader, "kind">): Promise<SessionHeader> {
    return this.createWithRecords(input, [])
  }

  async #writeNewSession(input: Omit<SessionHeader, "kind">, records: SessionRecord[]): Promise<SessionHeader> {
    const path = join(this.root, sessionFileName(input.createdAt, input.sessionId))
    const header: SessionHeader = { kind: "session", ...input }
    await atomicWriteFile(path, serializeSession(header, records))
    this.#paths.set(input.sessionId, path)
    this.#knownSessionIds.add(input.sessionId)
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
        const prefix = await this.#prepareAppend(path)
        const file = await open(path, "a")
        try {
          await file.writeFile(`${prefix}${JSON.stringify(validated)}\n`)
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
        await atomicWriteFile(path, serializeSession(loaded.header, records, loaded.unparsed ?? []))
      }),
    )
  }

  async read(sessionId: string): Promise<LoadedSession> {
    await this.#queues.get(sessionId)
    return this.#readPath(await this.#sessionPath(sessionId))
  }

  async #readPath(path: string): Promise<LoadedSession> {
    const fileStatus = await stat(path)
    const inspected = await this.#inspectPath(path, basename(path), fileStatus)
    if (!inspected.loaded || !inspected.summary.capabilities.canOpen) {
      const message = inspected.summary.issues[0]?.message ?? "会话文件不可读取"
      throw new Error(message)
    }
    return inspected.loaded
  }

  /**
   * 追加前修复进程异常留下的不完整尾行。完整但不兼容的尾行不会被删除，避免静默改写业务数据。
   */
  async #prepareAppend(path: string): Promise<string> {
    const contents = await readFile(path)
    if (contents.length === 0 || contents.at(-1) === 0x0a) return ""
    const lastNewline = contents.lastIndexOf(0x0a)
    const tail = contents.subarray(lastNewline + 1).toString("utf8")
    try {
      JSON.parse(tail)
      return "\n"
    } catch {
      const file = await open(path, "r+")
      try {
        await file.truncate(lastNewline + 1)
        await file.sync()
      } finally {
        await file.close()
      }
      return ""
    }
  }

  async #inspectPath(path: string, fileName: string, fileStatus: Stats): Promise<InspectedSession> {
    const base = {
      sessionId: "",
      name: fileName,
      cwd: "",
      createdAt: fileStatus.birthtime.toISOString(),
      updatedAt: fileStatus.mtime.toISOString(),
      preview: "无法读取会话摘要",
    }
    let contents: string
    try {
      contents = await readFile(path, "utf8")
    } catch (error) {
      const issue = sessionIssues.create(
        "session.read_failed",
        `读取会话文件失败：${error instanceof Error ? error.message : String(error)}`,
      )
      return {
        summary: {
          ...base,
          issues: [issue],
          capabilities: { canOpen: false, canForceOpen: false },
        },
      }
    }

    const rawLines = contents.split("\n")
    const terminated = rawLines.at(-1) === ""
    if (terminated) rawLines.pop()
    const issues: SessionIssue[] = []
    const warnings: string[] = []
    const unparsed: Array<{ beforeRecord: number; line: string }> = []
    let header: SessionHeader | undefined
    const records: SessionRecord[] = []
    for (const [index, rawLine] of rawLines.entries()) {
      let value: unknown
      try {
        value = JSON.parse(rawLine)
      } catch (error) {
        const line = index + 1
        const message = `会话文件第 ${line} 行无效：${error instanceof Error ? error.message : String(error)}`
        if (index === rawLines.length - 1 && !terminated && error instanceof SyntaxError) {
          warnings.push(`忽略不完整的最后一行（第 ${line} 行）`)
          issues.push(sessionIssues.create("session.incomplete_tail", message))
        } else issues.push(sessionIssues.create("session.invalid_json", message))
        continue
      }
      let parsed: SessionLine
      try {
        parsed = parseSessionValue(value)
      } catch (error) {
        const code =
          error instanceof UnknownSessionRecordTypeError
            ? "session.incompatible_record"
            : "session.record_validation_failed"
        issues.push(
          sessionIssues.create(
            code,
            `会话文件第 ${index + 1} 行无效：${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        // 未知记录类型是有效 JSON 但程序不认识，重写时保留原文以免静默丢弃业务数据；
        // 其他解析失败属于内容损坏，不保留（否则重写后会话仍无法打开）。
        if (code === "session.incompatible_record") unparsed.push({ beforeRecord: records.length, line: rawLine })
        continue
      }
      if (index === 0) {
        if (parsed.kind === "session") header = parsed
        else issues.push(sessionIssues.create("session.record_validation_failed", "会话文件第一行不是文件头"))
        continue
      }
      if (parsed.kind === "session") {
        issues.push(sessionIssues.create("session.record_validation_failed", "会话文件只能有一个文件头"))
        continue
      }
      records.push(parsed)
    }
    if (!header && !issues.some((issue) => issue.code === "session.incomplete_tail"))
      issues.push(sessionIssues.create("session.record_validation_failed", "会话文件缺少有效文件头"))

    // 只有真正的阻塞问题（内容损坏、读取失败）会阻止打开；未知记录类型
    // 不影响恢复，只保留 canForceOpen 风险标记供将来提示使用。
    const containsIncompatible = issues.some((issue) => issue.code === "session.incompatible_record")
    const hasBlockingIssues = issues.some(
      (issue) =>
        issue.code === "session.invalid_json" ||
        issue.code === "session.record_validation_failed" ||
        issue.code === "session.read_failed",
    )
    const capabilities = header
      ? { canOpen: !hasBlockingIssues, canForceOpen: containsIncompatible }
      : { canOpen: false, canForceOpen: false }
    const firstTurn = records.find((record): record is TurnStartedRecord => record.kind === "turn_started")
    const renamed = [...records].reverse().find((record) => record.kind === "session_renamed")
    const summary: SessionSummary = {
      ...base,
      ...(header
        ? {
            sessionId: header.sessionId,
            cwd: header.cwd,
            createdAt: header.createdAt,
            preview: firstTurn ? (firstText(firstTurn) ?? "新会话") : "新会话",
          }
        : {}),
      name: header && renamed?.kind === "session_renamed" ? renamed.name : header ? "" : fileName,
      issues,
      capabilities,
    }
    return {
      summary,
      ...(header ? { loaded: { header, records, warnings, unparsed } } : {}),
    }
  }

  async list(): Promise<SessionSummary[]> {
    await mkdir(this.root, { recursive: true })
    const previous = (await this.#index?.readProject(this.#projectKey)) ?? {}
    const current: Record<string, SessionIndexEntry> = {}
    const summaries: SessionSummary[] = []
    const summaryPaths = new Map<SessionSummary, string>()
    const seenSessionIds = new Set<string>()
    const entries = await readdir(this.root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const path = join(this.root, entry.name)
      let fileStatus: Stats | undefined
      try {
        fileStatus = await stat(path)
      } catch (error) {
        const now = new Date().toISOString()
        const issue = sessionIssues.create(
          "session.read_failed",
          `读取会话文件状态失败：${error instanceof Error ? error.message : String(error)}`,
        )
        summaries.push({
          sessionId: "",
          name: entry.name,
          cwd: "",
          createdAt: now,
          updatedAt: now,
          preview: "无法读取会话摘要",
          issues: [issue],
          capabilities: { canOpen: false, canForceOpen: false },
        })
        continue
      }
      const cached = previous[entry.name]
      const unchanged =
        cached?.size === fileStatus.size &&
        cached.birthtimeMs === fileStatus.birthtimeMs &&
        cached.mtimeMs === fileStatus.mtimeMs
      let summary: SessionSummary
      if (unchanged && cached) {
        // 含问题标记的摘要可能是旧版解析/判定结果（如缓存版本升级前写入的
        // capabilities），重新检查文件以使用当前判定规则；健康会话直接复用缓存。
        summary =
          cached.summary.issues.length > 0
            ? (await this.#inspectPath(path, entry.name, fileStatus)).summary
            : { ...cached.summary }
      } else {
        summary = (await this.#inspectPath(path, entry.name, fileStatus)).summary
      }
      current[entry.name] = {
        size: fileStatus.size,
        birthtimeMs: fileStatus.birthtimeMs,
        mtimeMs: fileStatus.mtimeMs,
        summary: structuredClone(summary),
      }
      if (summary.sessionId) {
        if (seenSessionIds.has(summary.sessionId)) continue
        seenSessionIds.add(summary.sessionId)
      }
      summaryPaths.set(summary, path)
      summaries.push(summary)
    }

    const sessionIds = new Set(summaries.map((summary) => summary.sessionId).filter((sessionId) => sessionId !== ""))
    this.#paths.clear()
    this.#blockedReasons.clear()
    this.#knownSessionIds.clear()
    for (const summary of summaries) {
      if (!summary.sessionId) continue
      this.#knownSessionIds.add(summary.sessionId)
      const path = summaryPaths.get(summary)
      if (summary.capabilities.canOpen) {
        if (path) this.#paths.set(summary.sessionId, path)
      } else if (path) {
        this.#blockedReasons.set(summary.sessionId, summary.issues[0]?.message ?? "会话存在阻塞性问题，暂不可打开")
      }
    }
    const lockStates = await Promise.all(
      [...sessionIds].map(async (sessionId) => {
        try {
          const locked = await isFileLocked(this.#lockPath(sessionId))
          return {
            sessionId,
            state: locked ? (this.#currentSessionId === sessionId ? "current" : "occupied") : "available",
          } as const
        } catch (error) {
          return {
            sessionId,
            error: `读取会话占用状态失败：${error instanceof Error ? error.message : String(error)}`,
          } as const
        }
      }),
    )
    const states = new Map(lockStates.map((result) => [result.sessionId, result] as const))
    for (const summary of summaries) {
      const lock = states.get(summary.sessionId)
      if (lock && "error" in lock) {
        summary.issues = [...summary.issues, sessionIssues.create("session.read_failed", lock.error)]
        summary.capabilities = { canOpen: false, canForceOpen: false }
        continue
      }
      summary.lockState = lock?.state ?? "available"
      if (summary.lockState === "occupied") {
        summary.issues = [
          ...summary.issues,
          sessionIssues.create("session.in_use", `会话正在被其他 Agent 使用：${summary.sessionId}`),
        ]
        summary.capabilities = { canOpen: false, canForceOpen: false }
      }
    }
    this.#warnings = this.#index ? await this.#index.updateProject(this.#projectKey, current) : []
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async #refreshPaths(): Promise<void> {
    await this.list()
  }

  async #sessionPath(sessionId: string): Promise<string> {
    if (!sessionId) throw new Error("无效的会话 ID")
    const known = this.#paths.get(sessionId)
    if (known) return known
    await this.#refreshPaths()
    const path = this.#paths.get(sessionId)
    if (!path) {
      if (this.#knownSessionIds.has(sessionId))
        throw new Error(`会话无法打开：${this.#blockedReasons.get(sessionId) ?? "会话存在阻塞性问题，暂不可打开"}`)
      throw new Error(`会话不存在：${sessionId}`)
    }
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
