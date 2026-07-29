import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import lockfile from "proper-lockfile"
import type { SessionSummary } from "./session-store.ts"

export type SessionIndexEntry = {
  size: number
  birthtimeMs: number
  mtimeMs: number
  summary: SessionSummary
}

type SessionIndex = {
  version: 1
  projects: Record<string, Record<string, SessionIndexEntry>>
}

const emptyIndex = (): SessionIndex => ({ version: 1, projects: {} })
const queues = new Map<string, Promise<void>>()

function validEntry(value: unknown): value is SessionIndexEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as Partial<SessionIndexEntry>
  const summary = entry.summary
  return (
    typeof entry.size === "number" &&
    typeof entry.birthtimeMs === "number" &&
    typeof entry.mtimeMs === "number" &&
    !!summary &&
    typeof summary.sessionId === "string" &&
    typeof summary.name === "string" &&
    typeof summary.cwd === "string" &&
    typeof summary.createdAt === "string" &&
    typeof summary.updatedAt === "string" &&
    typeof summary.preview === "string"
  )
}

function parseIndex(value: unknown): SessionIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyIndex()
  const source = value as Partial<SessionIndex>
  if (source.version !== 1 || !source.projects || typeof source.projects !== "object" || Array.isArray(source.projects))
    return emptyIndex()
  for (const project of Object.values(source.projects)) {
    if (!project || typeof project !== "object" || Array.isArray(project)) return emptyIndex()
    if (!Object.values(project).every(validEntry)) return emptyIndex()
  }
  return { version: 1, projects: source.projects }
}

/**
 * 管理可重建的会话摘要索引，并通过进程内队列和跨进程锁避免更新覆盖。
 */
export class SessionIndexStore {
  readonly #path: string
  readonly #lockPath: string

  constructor(path: string) {
    this.#path = path
    this.#lockPath = path.replace(/\.json$/i, ".lock")
  }

  /** 读取索引；文件不存在、损坏或版本不符时返回空索引。 */
  async readProject(projectKey: string): Promise<Record<string, SessionIndexEntry>> {
    const index = await this.#read()
    return structuredClone(index.projects[projectKey] ?? {})
  }

  /**
   * 在锁内重读并合并一个项目的摘要；失败时返回非阻断警告。
   */
  async updateProject(projectKey: string, entries: Record<string, SessionIndexEntry>): Promise<string[]> {
    const previous = queues.get(this.#path) ?? Promise.resolve()
    let warnings: string[] = []
    const operation = previous.then(async () => {
      warnings = await this.#updateLocked(projectKey, entries)
    })
    const settled = operation.catch(() => {})
    queues.set(this.#path, settled)
    try {
      await operation
    } catch (error) {
      warnings = [
        `会话摘要缓存更新失败，将在下次重新构建；会话文件未受影响：${error instanceof Error ? error.message : String(error)}`,
      ]
    } finally {
      if (queues.get(this.#path) === settled) queues.delete(this.#path)
    }
    return warnings
  }

  async #updateLocked(projectKey: string, entries: Record<string, SessionIndexEntry>): Promise<string[]> {
    await mkdir(dirname(this.#path), { recursive: true })
    const release = await lockfile.lock(this.#path, {
      realpath: false,
      lockfilePath: this.#lockPath,
      stale: 10_000,
      update: 2_000,
      retries: { retries: 20, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
    })
    try {
      const index = await this.#read()
      index.projects[projectKey] = structuredClone(entries)
      await this.#replace(index)
      return []
    } finally {
      await release()
    }
  }

  async #read(): Promise<SessionIndex> {
    try {
      return parseIndex(JSON.parse(await readFile(this.#path, "utf8")))
    } catch {
      return emptyIndex()
    }
  }

  async #replace(index: SessionIndex): Promise<void> {
    await this.#cleanupTemporaryFiles()
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8")
    try {
      await rename(temporary, this.#path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async #cleanupTemporaryFiles(): Promise<void> {
    const directory = dirname(this.#path)
    const prefix = `${this.#path.slice(directory.length + 1)}.`
    const entries = await readdir(directory, { withFileTypes: true })
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".tmp"))
        .map((entry) => rm(`${directory}/${entry.name}`, { force: true })),
    )
  }
}
