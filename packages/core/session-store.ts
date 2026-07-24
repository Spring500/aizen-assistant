import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  parseSessionValue,
  type SessionHeader,
  type SessionLine,
  type SessionRecord,
  type TurnStartedRecord,
} from "./session-format.ts"

export type SessionSummary = {
  sessionId: string
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

  constructor(root: string) {
    this.root = root
  }

  sessionDirectory(sessionId: string): string {
    if (!sessionId || sessionId === "." || sessionId === ".." || /[\\/]/.test(sessionId))
      throw new Error("无效的会话 ID")
    return join(this.root, sessionId)
  }

  sessionFile(sessionId: string): string {
    return join(this.sessionDirectory(sessionId), "conversation.jsonl")
  }

  async create(input: Omit<SessionHeader, "kind" | "version">): Promise<SessionHeader> {
    await mkdir(this.root, { recursive: true })
    const directory = this.sessionDirectory(input.sessionId)
    await mkdir(directory)
    const header: SessionHeader = { kind: "session", version: 1, ...input }
    try {
      const file = await open(this.sessionFile(input.sessionId), "wx")
      try {
        await file.writeFile(`${JSON.stringify(header)}\n`)
        await file.sync()
      } finally {
        await file.close()
      }
      return header
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
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
    if (header.sessionId !== sessionId) throw new Error("会话目录与文件头 ID 不一致")
    if (records.some((record) => record.kind === "session")) throw new Error("会话文件只能有一个文件头")
    return { header, records: records as SessionRecord[], warnings }
  }

  async list(): Promise<SessionSummary[]> {
    await mkdir(this.root, { recursive: true })
    const entries = await readdir(this.root, { withFileTypes: true })
    const summaries: SessionSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const loaded = await this.read(entry.name)
      const fileStatus = await stat(this.sessionFile(entry.name))
      const firstTurn = loaded.records.find((record): record is TurnStartedRecord => record.kind === "turn_started")
      summaries.push({
        sessionId: loaded.header.sessionId,
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
