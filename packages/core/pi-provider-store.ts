import { readFile } from "node:fs/promises"
import { atomicWriteFile, withFileLock } from "./file-transaction.ts"

export type PiProviderSelection = { enabled: string[] }

function parse(value: unknown): PiProviderSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pi-providers.json 必须是对象")
  const enabled = (value as { enabled?: unknown }).enabled
  if (!Array.isArray(enabled) || !enabled.every((item) => typeof item === "string" && item.length > 0))
    throw new Error("pi-providers.json.enabled 必须是非空字符串数组")
  return { enabled: [...new Set(enabled)].sort() }
}

/** 读写用户启用的 pi 供应商，不保存 pi 供应商定义或模型目录。 */
export class PiProviderStore {
  readonly #path: string
  constructor(path: string) {
    this.#path = path
  }

  async read(): Promise<PiProviderSelection> {
    try {
      return parse(JSON.parse(await readFile(this.#path, "utf8")))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: [] }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  async setEnabled(providerId: string, enabled: boolean): Promise<PiProviderSelection> {
    await this.#ensureFile()
    return withFileLock(this.#path, async () => {
      const current = await this.read()
      const values = new Set(current.enabled)
      if (enabled) values.add(providerId)
      else values.delete(providerId)
      const next = { enabled: [...values].sort() }
      await atomicWriteFile(this.#path, `${JSON.stringify(next, null, 2)}\n`)
      return next
    })
  }

  async #ensureFile(): Promise<void> {
    try {
      await readFile(this.#path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await atomicWriteFile(this.#path, '{\n  "enabled": []\n}\n')
    }
  }
}
