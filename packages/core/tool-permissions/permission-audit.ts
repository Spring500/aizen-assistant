import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { PermissionAuditEvent } from "./types.ts"

export type PermissionAuditRecorder = {
  record(event: PermissionAuditEvent): Promise<void>
  close?(): Promise<void>
}

/**
 * 将权限判定过程按 JSONL 追加到本地文件，按大小轮转并保留窗口内文件。
 * 仅存本地、可查看删除；写入内容由调用方先经过 sanitizer 脱敏。
 */
export class JsonlPermissionAuditRecorder implements PermissionAuditRecorder {
  readonly #path: string
  readonly #maxBytes: number
  readonly #maxFiles: number
  #handle: FileHandle | undefined
  #size = 0
  #queue = Promise.resolve()
  #closed = false

  constructor(path: string, maxBytes = 16 * 1024 * 1024, maxFiles = 5) {
    this.#path = path
    this.#maxBytes = maxBytes
    this.#maxFiles = maxFiles
  }

  async record(event: PermissionAuditEvent): Promise<void> {
    if (this.#closed) return
    const operation = this.#queue.then(async () => {
      await this.#rotateIfNeeded()
      const handle = await this.#file()
      const line = `${JSON.stringify(event)}\n`
      await handle.write(line)
      this.#size += Buffer.byteLength(line)
    })
    this.#queue = operation.catch(() => {})
    await operation
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#queue
    await this.#handle?.close()
    this.#handle = undefined
  }

  async #file(): Promise<FileHandle> {
    if (this.#handle) return this.#handle
    await mkdir(dirname(this.#path), { recursive: true })
    this.#handle = await open(this.#path, "a")
    this.#size = (await this.#handle.stat()).size
    return this.#handle
  }

  /** 当前文件超过阈值时轮转：重命名现有文件为 .1，清理超出保留窗口的最旧文件。 */
  async #rotateIfNeeded(): Promise<void> {
    await this.#file()
    if (this.#size <= this.#maxBytes) return
    await this.#handle?.close()
    this.#handle = undefined
    for (let index = this.#maxFiles - 1; index >= 1; index--) {
      const current = `${this.#path}.${index}`
      const previous = index === 1 ? this.#path : `${this.#path}.${index - 1}`
      try {
        await rename(previous, current)
      } catch {
        // 前序文件不存在时跳过
      }
    }
    this.#size = 0
    try {
      await unlink(`${this.#path}.${this.#maxFiles}`)
    } catch {
      // 超出窗口的最旧文件可能不存在
    }
  }
}

export function permissionAuditPath(dataDirectory: string): string {
  return join(dataDirectory, "permission-audit.jsonl")
}
