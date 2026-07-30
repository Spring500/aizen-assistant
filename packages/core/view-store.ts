import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"

import { atomicWriteFile, withFileLock } from "./file-transaction.ts"
import { WordTripletIdGenerator, type MnemonicIdGenerator } from "./mnemonic-id.ts"

export type ViewDefinition = {
  id: string
  name: string
  path: string
}

export type ViewOption = ViewDefinition & {
  directory: string
  valid: boolean
  error?: string
}

export type ResolvedView = ViewDefinition & {
  directory: string
}

type ViewsFile = { version: 1; views: ViewDefinition[] }

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label} 包含未知字段：${key}`)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`)
  return value
}

export function parseViewsValue(value: unknown): ViewsFile {
  const source = object(value, "views.json")
  exact(source, ["version", "views"], "views.json")
  if (source.version !== 1) throw new Error(`不支持的 views.json 版本：${String(source.version)}`)
  if (!Array.isArray(source.views)) throw new Error("views.json.views 必须是数组")
  const ids = new Set<string>()
  const views = source.views.map((item, index) => {
    const view = object(item, `views[${index}]`)
    exact(view, ["id", "name", "path"], `views[${index}]`)
    const id = requiredString(view.id, `views[${index}].id`)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`视图 ID 格式无效：${id}`)
    if (ids.has(id)) throw new Error(`视图 ID 重复：${id}`)
    ids.add(id)
    return {
      id,
      name: requiredString(view.name, `views[${index}].name`),
      path: requiredString(view.path, `views[${index}].path`),
    }
  })
  return { version: 1, views }
}

export class ViewStore {
  readonly #file: string
  readonly #baseDirectory: string
  readonly #idGenerator: MnemonicIdGenerator

  constructor(file: string, options: { idGenerator?: MnemonicIdGenerator } = {}) {
    this.#file = file
    this.#baseDirectory = dirname(file)
    this.#idGenerator = options.idGenerator ?? new WordTripletIdGenerator()
  }

  async #read(): Promise<ViewsFile> {
    let text: string
    try {
      text = await readFile(this.#file, "utf8")
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return { version: 1, views: [] }
      throw new Error(`无法读取 views.json：${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      return parseViewsValue(JSON.parse(text))
    } catch (error) {
      throw new Error(`views.json 配置错误：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #directory(view: ViewDefinition): string {
    return isAbsolute(view.path) ? resolve(view.path) : resolve(this.#baseDirectory, view.path)
  }

  async list(): Promise<ViewOption[]> {
    const { views } = await this.#read()
    return Promise.all(
      views.map(async (view) => {
        const directory = this.#directory(view)
        try {
          if (!(await stat(directory)).isDirectory()) throw new Error("路径不是目录")
          return { ...view, directory, valid: true }
        } catch (error) {
          return {
            ...view,
            directory,
            valid: false,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )
  }

  async resolve(id: string): Promise<ResolvedView> {
    const view = (await this.#read()).views.find((item) => item.id === id)
    if (!view) throw new Error(`视图不存在：${id}`)
    const directory = this.#directory(view)
    try {
      if (!(await stat(directory)).isDirectory()) throw new Error("路径不是目录")
    } catch (error) {
      throw new Error(
        `视图 ${id} 的路径失效：${directory}（${error instanceof Error ? error.message : String(error)}）`,
      )
    }
    return { ...view, directory }
  }

  async suggestId(): Promise<string> {
    const file = await this.#read()
    const existing = new Set(file.views.map((view) => view.id.toLowerCase()))
    return this.#idGenerator.generate((candidate) => existing.has(candidate.toLowerCase()))
  }

  async create(input: { id?: string; name: string }): Promise<ResolvedView> {
    const id = input.id ?? (await this.suggestId())
    const parsed = parseViewsValue({ version: 1, views: [{ id, name: input.name, path: join("views", id) }] }).views[0]
    if (!parsed) throw new Error("无法创建视图")
    const directory = this.#directory(parsed)
    await withFileLock(this.#file, async () => {
      const file = await this.#read()
      if (file.views.some((view) => view.id === parsed.id)) throw new Error(`视图 ID 重复：${parsed.id}`)
      await mkdir(join(directory, "skills"), { recursive: true })
      await writeFile(join(directory, "AGENTS.md"), "# 视图说明\n\n请在这里填写项目背景和工作要求。\n", {
        flag: "wx",
      }).catch((error) => {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
      })
      file.views.push(parsed)
      await atomicWriteFile(this.#file, `${JSON.stringify(file, null, 2)}\n`)
    })
    return { ...parsed, directory }
  }

  async update(id: string, changes: { name?: string; path?: string }): Promise<void> {
    await withFileLock(this.#file, async () => {
      const file = await this.#read()
      const index = file.views.findIndex((view) => view.id === id)
      if (index < 0) throw new Error(`视图不存在：${id}`)
      const current = file.views[index]
      if (!current) throw new Error(`视图不存在：${id}`)
      const updated = parseViewsValue({
        version: 1,
        views: [
          {
            ...current,
            ...(changes.name === undefined ? {} : { name: changes.name }),
            ...(changes.path === undefined ? {} : { path: changes.path }),
          },
        ],
      }).views[0]
      if (!updated) throw new Error("无法更新视图")
      file.views[index] = updated
      await atomicWriteFile(this.#file, `${JSON.stringify(file, null, 2)}\n`)
    })
  }

  async ensureFile(id: string, name: "SYSTEM.md" | "AGENTS.md"): Promise<string> {
    const view = await this.resolve(id)
    const path = join(view.directory, name)
    await writeFile(path, "", { flag: "a" })
    return path
  }

  async remove(id: string): Promise<void> {
    await withFileLock(this.#file, async () => {
      const file = await this.#read()
      const index = file.views.findIndex((view) => view.id === id)
      if (index < 0) throw new Error(`视图不存在：${id}`)
      file.views.splice(index, 1)
      await atomicWriteFile(this.#file, `${JSON.stringify(file, null, 2)}\n`)
    })
  }

  async deleteDirectory(id: string): Promise<void> {
    const view = await this.resolve(id)
    await this.remove(id)
    await rm(view.directory, { recursive: true, force: true })
  }
}
