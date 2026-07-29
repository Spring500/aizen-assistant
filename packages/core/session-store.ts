import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises"
import { basename, join } from "node:path"
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

export type SessionSummary = {
  sessionId: string
  name: string
  cwd: string
  createdAt: string
  updatedAt: string
  preview: string
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

export class SessionStore {
  readonly root: string
  readonly #queues = new Map<string, Promise<void>>()
  readonly #paths = new Map<string, string>()
  readonly #idGenerator: MnemonicIdGenerator
  readonly #index: SessionIndexStore | undefined
  readonly #projectKey: string
  #warnings: string[] = []

  constructor(root: string, options: { idGenerator?: MnemonicIdGenerator; indexPath?: string } = {}) {
    this.root = root
    this.#idGenerator = options.idGenerator ?? new WordTripletIdGenerator()
    this.#index = options.indexPath ? new SessionIndexStore(options.indexPath) : undefined
    this.#projectKey = basename(root)
  }

  /** 生成一个不与现有会话冲突的助记词 ID。 */
  async suggestId(): Promise<string> {
    const existing = new Set((await this.list()).map((session) => session.sessionId.toLowerCase()))
    return this.#idGenerator.generate((candidate) => existing.has(candidate.toLowerCase()))
  }

  async create(input: Omit<SessionHeader, "kind" | "version">): Promise<SessionHeader> {
    await mkdir(this.root, { recursive: true })
    await this.list()
    if (this.#paths.has(input.sessionId)) throw new Error("会话 ID 已存在")
    const path = join(this.root, sessionFileName(input.createdAt, input.sessionId))
    const header: SessionHeader = { kind: "session", version: 1, ...input }
    const file = await open(path, "wx")
    let written = false
    try {
      await file.writeFile(`${JSON.stringify(header)}\n`)
      await file.sync()
      written = true
      this.#paths.set(input.sessionId, path)
      return header
    } finally {
      await file.close()
      if (!written) await rm(path, { force: true })
    }
  }

  append(sessionId: string, record: SessionRecord): Promise<void> {
    const validated = parseSessionValue(record)
    if (validated.kind === "session") throw new Error("不能追加第二个会话文件头")
    const previous = this.#queues.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const file = await open(await this.#sessionPath(sessionId), "a")
      try {
        await file.writeFile(`${JSON.stringify(validated)}\n`)
        await file.sync()
      } finally {
        await file.close()
      }
    })
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
        summary = cached.summary
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
    this.#warnings = this.#index ? await this.#index.updateProject(this.#projectKey, current) : []
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async #sessionPath(sessionId: string): Promise<string> {
    if (!sessionId) throw new Error("无效的会话 ID")
    const known = this.#paths.get(sessionId)
    if (known) return known
    await this.list()
    const path = this.#paths.get(sessionId)
    if (!path) throw new Error(`会话不存在：${sessionId}`)
    return path
  }

  /** 取出最近一次列表操作产生的非阻断警告。 */
  takeWarnings(): string[] {
    return this.#warnings.splice(0)
  }

  async flush(): Promise<void> {
    await Promise.all(this.#queues.values())
  }
}
