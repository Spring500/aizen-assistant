import { type FileHandle, mkdir, open } from "node:fs/promises"
import { dirname } from "node:path"
import type { PermissionGapRecord, PermissionGapRecorder } from "./types.ts"

/** 将权限规则缺口按 JSONL 顺序追加到本地文件，并在关闭时等待已排队写入完成。 */
export class JsonlPermissionGapRecorder implements PermissionGapRecorder {
  readonly #path: string
  #handle: FileHandle | undefined
  #queue = Promise.resolve()
  #closed = false

  constructor(path: string) {
    this.#path = path
  }

  async record(record: PermissionGapRecord): Promise<void> {
    if (this.#closed) return
    const operation = this.#queue.then(async () => {
      const handle = await this.#file()
      await handle.write(`${JSON.stringify(record)}\n`)
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
    return this.#handle
  }
}
