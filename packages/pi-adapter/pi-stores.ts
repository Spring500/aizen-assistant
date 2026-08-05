import { readFile } from "node:fs/promises"
import type { Credential, CredentialInfo, CredentialStore, ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai"
import { atomicWriteFile, withFileLock } from "../core/file-transaction.ts"

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

function credential(value: unknown): Credential {
  const source = object(value, "auth.json 认证信息")
  if (source.type !== "api_key" && source.type !== "oauth") throw new Error("auth.json 认证信息类型无效")
  return source as Credential
}

/** 以 Aizen 的 auth.json 实现 pi-ai 凭据存储；列表操作不读取或暴露密钥。 */
export class PiCredentialStore implements CredentialStore {
  readonly #path: string
  constructor(path: string) {
    this.#path = path
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const source = await this.#read()
    return source[providerId] === undefined ? undefined : credential(source[providerId])
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const source = await this.#read()
    return Object.entries(source).map(([providerId, value]) => ({ providerId, type: credential(value).type }))
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    await this.#ensureFile()
    return withFileLock(this.#path, async () => {
      const source = await this.#read()
      const current = source[providerId] === undefined ? undefined : credential(source[providerId])
      const next = await fn(current)
      if (next === undefined) return current
      source[providerId] = structuredClone(next)
      await atomicWriteFile(this.#path, `${JSON.stringify(source, null, 2)}\n`)
      return next
    })
  }

  async delete(providerId: string): Promise<void> {
    await this.#ensureFile()
    await withFileLock(this.#path, async () => {
      const source = await this.#read()
      delete source[providerId]
      await atomicWriteFile(this.#path, `${JSON.stringify(source, null, 2)}\n`)
    })
  }

  async #ensureFile(): Promise<void> {
    try {
      await readFile(this.#path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await atomicWriteFile(this.#path, "{}\n")
    }
  }

  async #read(): Promise<Record<string, unknown>> {
    try {
      return object(JSON.parse(await readFile(this.#path, "utf8")), "auth.json")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw error instanceof Error ? error : new Error(String(error))
    }
  }
}

/** 以单一 JSON 文件保存 pi-ai 动态模型目录，并使用文件事务保护更新。 */
export class PiModelsCacheStore implements ModelsStore {
  readonly #path: string
  constructor(path: string) {
    this.#path = path
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    const source = await this.#read()
    return source[providerId] === undefined ? undefined : structuredClone(source[providerId] as ModelsStoreEntry)
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    await this.#ensureFile()
    await withFileLock(this.#path, async () => {
      const source = await this.#read()
      source[providerId] = structuredClone(entry)
      await atomicWriteFile(this.#path, `${JSON.stringify(source, null, 2)}\n`)
    })
  }

  async delete(providerId: string): Promise<void> {
    await this.#ensureFile()
    await withFileLock(this.#path, async () => {
      const source = await this.#read()
      delete source[providerId]
      await atomicWriteFile(this.#path, `${JSON.stringify(source, null, 2)}\n`)
    })
  }

  async #ensureFile(): Promise<void> {
    try {
      await readFile(this.#path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await atomicWriteFile(this.#path, "{}\n")
    }
  }

  async #read(): Promise<Record<string, unknown>> {
    try {
      return object(JSON.parse(await readFile(this.#path, "utf8")), "pi-models-cache.json")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw error instanceof Error ? error : new Error(String(error))
    }
  }
}
