import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { WordTripletIdGenerator, type MnemonicIdGenerator } from "./mnemonic-id.ts"
import {
  parseSessionValue,
  type SessionHeader,
  type SessionLine,
  type SessionRecord,
  type TurnStartedRecord,
} from "./session-format.ts"

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
  readonly #idGenerator: MnemonicIdGenerator

  constructor(root: string, options: { idGenerator?: MnemonicIdGenerator } = {}) {
    this.root = root
    this.#idGenerator = options.idGenerator ?? new WordTripletIdGenerator()
  }

  sessionFile(sessionId: string): string {
    if (!sessionId || sessionId === "." || sessionId === ".." || /[\\/]/.test(sessionId))
      throw new Error("无效的会话 ID")
    return join(this.root, `${sessionId}.jsonl`)
  }

  /** 生成一个不与现有会话冲突的助记词 ID。 */
  async suggestId(): Promise<string> {
    await mkdir(this.root, { recursive: true })
    const entries = await readdir(this.root, { withFileTypes: true })
    const existing = new Set(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name.slice(0, -".jsonl".length).toLowerCase()),
    )
    return this.#idGenerator.generate((candidate) => existing.has(candidate.toLowerCase()))
  }

  async create(input: Omit<SessionHeader, "kind" | "version">): Promise<SessionHeader> {
    await mkdir(this.root, { recursive: true })
    const path = this.sessionFile(input.sessionId)
    const header: SessionHeader = { kind: "session", version: 1, ...input }
    const file = await open(path, "wx")
    let written = false
    try {
      await file.writeFile(`${JSON.stringify(header)}\n`)
      await file.sync()
      written = true
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
      const file = await open(this.sessionFile(sessionId), "a")
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
    const contents = await readFile(this.sessionFile(sessionId), "utf8")
    const rawLines = contents.split("\n")
    if (rawLines.at(-1) === "") rawLines.pop()
    const lines: SessionLine[] = []
    const warnings: string[] = []
    for (const [index, rawLine] of rawLines.entries()) {
      try {
        lines.push(parseSessionValue(JSON.parse(rawLine)))
      } catch (error) {
        const isLast = index === rawLines.length - 1
        const isSyntaxError = error instanceof SyntaxError
        if (isLast && isSyntaxError) {
          warnings.push(`忽略不完整的最后一行（第 ${index + 1} 行）`)
          continue
        }
        throw new Error(`会话文件第 ${index + 1} 行无效：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const [header, ...records] = lines
    if (header?.kind !== "session") throw new Error("会话文件第一行不是文件头")
    if (header.sessionId !== sessionId) throw new Error("会话文件名与文件头 ID 不一致")
    if (records.some((record) => record.kind === "session")) throw new Error("会话文件只能有一个文件头")
    return { header, records: records as SessionRecord[], warnings }
  }

  async list(): Promise<SessionSummary[]> {
    await mkdir(this.root, { recursive: true })
    const entries = await readdir(this.root, { withFileTypes: true })
    const summaries: SessionSummary[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const sessionId = entry.name.slice(0, -".jsonl".length)
      const loaded = await this.read(sessionId)
      const fileStatus = await stat(this.sessionFile(sessionId))
      const firstTurn = loaded.records.find((record): record is TurnStartedRecord => record.kind === "turn_started")
      const renamed = [...loaded.records].reverse().find((record) => record.kind === "session_renamed")
      summaries.push({
        sessionId: loaded.header.sessionId,
        name: renamed?.kind === "session_renamed" ? renamed.name : "",
        cwd: loaded.header.cwd,
        createdAt: loaded.header.createdAt,
        updatedAt: fileStatus.mtime.toISOString(),
        preview: firstTurn ? (firstText(firstTurn) ?? "新会话") : "新会话",
      })
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async flush(): Promise<void> {
    await Promise.all(this.#queues.values())
  }
}
