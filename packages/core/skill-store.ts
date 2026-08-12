import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, readdir, rm } from "node:fs/promises"
import { relative, join, resolve } from "node:path"

import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent"

import { atomicWriteFile, withFileLock } from "./file-transaction.ts"
import { fetchRepo, type FetchRepo } from "./git-fetch.ts"

/** 已安装的第三方 skill：name 为身份主键，sourceUrl/ref/relPath 仅描述下载与更新来源。 */
export type InstalledSkill = {
  name: string
  sourceUrl: string
  ref?: string
  relPath: string
  description?: string
}

export type DiscoveredSkill = {
  name: string
  description?: string
  relPath: string
}

type SkillsFile = { skills: InstalledSkill[] }

function toPosix(path: string): string {
  return path.split("\\").join("/")
}

export type SkillStoreOptions = {
  file: string
  cacheDirectory: string
  /** 仓库拉取实现，测试可注入替身；默认使用 isomorphic-git。 */
  fetchRepo?: FetchRepo
}

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

export function parseSkillsValue(value: unknown): SkillsFile {
  const source = object(value, "skills.json")
  exact(source, ["skills"], "skills.json")
  if (!Array.isArray(source.skills)) throw new Error("skills.json.skills 必须是数组")
  const skills = source.skills.map((item, index) => {
    const skill = object(item, `skills[${index}]`)
    exact(skill, ["name", "sourceUrl", "ref", "relPath", "description"], `skills[${index}]`)
    const ref = skill.ref === undefined ? undefined : requiredString(skill.ref, `skills[${index}].ref`)
    const description =
      skill.description === undefined ? undefined : requiredString(skill.description, `skills[${index}].description`)
    return {
      name: requiredString(skill.name, `skills[${index}].name`),
      sourceUrl: requiredString(skill.sourceUrl, `skills[${index}].sourceUrl`),
      relPath: requiredString(skill.relPath, `skills[${index}].relPath`),
      ...(ref === undefined ? {} : { ref }),
      ...(description === undefined ? {} : { description }),
    }
  })
  return { skills }
}

export class SkillStore {
  readonly #file: string
  readonly #cacheDirectory: string
  readonly #fetchRepo: FetchRepo

  constructor(options: SkillStoreOptions) {
    this.#file = options.file
    this.#cacheDirectory = options.cacheDirectory
    this.#fetchRepo = options.fetchRepo ?? fetchRepo
  }

  #cacheDirectoryFor(url: string, ref?: string): string {
    const digest = createHash("sha1")
      .update(`${url}\0${ref ?? ""}`)
      .digest("hex")
    return join(this.#cacheDirectory, digest)
  }

  #skillDirectory(skill: InstalledSkill): string {
    return resolve(join(this.#cacheDirectoryFor(skill.sourceUrl, skill.ref), skill.relPath))
  }

  async #read(): Promise<SkillsFile> {
    let text: string
    try {
      text = await readFile(this.#file, "utf8")
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { skills: [] }
      throw new Error(`无法读取 skills.json：${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      return parseSkillsValue(JSON.parse(text))
    } catch (error) {
      throw new Error(`skills.json 配置错误：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async list(): Promise<InstalledSkill[]> {
    return (await this.#read()).skills
  }

  hasName(name: string): Promise<boolean> {
    return this.#read().then((file) => file.skills.some((skill) => skill.name === name))
  }

  /** 引入仓库并把其中的 skill 扫描出来（不落盘，扫描口径与 pi 装载一致）。 */
  async discoverSource(url: string, ref?: string): Promise<DiscoveredSkill[]> {
    const cacheDir = this.#cacheDirectoryFor(url, ref)
    await this.#fetchRepo(cacheDir, url, ref)
    const result = loadSkillsFromDir({ dir: cacheDir, source: url })
    return result.skills.map((skill) => ({
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
      relPath: toPosix(relative(cacheDir, skill.baseDir)),
    }))
  }

  /** 登记安装。同名已存在时返回冲突，由调用方决定替换或放弃，不做静默覆盖。 */
  async installSkill(
    input: InstalledSkill,
  ): Promise<{ installed: InstalledSkill } | { conflict: { existing: InstalledSkill } }> {
    return withFileLock(this.#file, async () => {
      const file = await this.#read()
      const existing = file.skills.find((skill) => skill.name === input.name)
      if (existing) return { conflict: { existing } }
      const installed: InstalledSkill = {
        name: input.name,
        sourceUrl: input.sourceUrl,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        relPath: input.relPath,
        ...(input.description === undefined ? {} : { description: input.description }),
      }
      file.skills.push(installed)
      await atomicWriteFile(this.#file, `${JSON.stringify(file, null, 2)}\n`)
      return { installed }
    })
  }

  /** 用新来源覆盖同名 skill 的下载与更新信息，保留身份主键 name。 */
  async replaceSkill(name: string, input: Omit<InstalledSkill, "name">): Promise<void> {
    await withFileLock(this.#file, async () => {
      const file = await this.#read()
      const index = file.skills.findIndex((skill) => skill.name === name)
      if (index < 0) throw new Error(`未安装的 skill：${name}`)
      file.skills[index] = {
        name,
        sourceUrl: input.sourceUrl,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        relPath: input.relPath,
        ...(input.description === undefined ? {} : { description: input.description }),
      }
      await atomicWriteFile(this.#file, `${JSON.stringify(file, null, 2)}\n`)
    })
  }

  async removeSkill(name: string): Promise<void> {
    await withFileLock(this.#file, async () => {
      const file = await this.#read()
      const index = file.skills.findIndex((skill) => skill.name === name)
      if (index < 0) throw new Error(`未安装的 skill：${name}`)
      file.skills.splice(index, 1)
      await atomicWriteFile(this.#file, `${JSON.stringify(file, null, 2)}\n`)
      await this.#cleanupUnusedCache(file.skills)
    })
  }

  /** 按 (url, ref) 分组重新拉取全部已安装来源；内容就地刷新，所有引用自动生效。 */
  async updateSkills(): Promise<{ updated: number; errors: string[] }> {
    const file = await this.#read()
    const groups = new Map<string, { url: string; ref?: string }>()
    for (const skill of file.skills) {
      const key = `${skill.sourceUrl}\0${skill.ref ?? ""}`
      if (!groups.has(key))
        groups.set(key, { url: skill.sourceUrl, ...(skill.ref === undefined ? {} : { ref: skill.ref }) })
    }
    const errors: string[] = []
    for (const { url, ref } of groups.values()) {
      try {
        await this.#fetchRepo(this.#cacheDirectoryFor(url, ref), url, ref)
      } catch (error) {
        errors.push(`${url}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { updated: groups.size - errors.length, errors }
  }

  /** 只更新单个 skill 的来源仓库；同源其它 skill 一并随之刷新。 */
  async updateSkill(name: string): Promise<void> {
    const skill = (await this.#read()).skills.find((item) => item.name === name)
    if (!skill) throw new Error(`未安装的 skill：${name}`)
    await this.#fetchRepo(this.#cacheDirectoryFor(skill.sourceUrl, skill.ref), skill.sourceUrl, skill.ref)
  }

  /**
   * 解析用户层实际可挂载的 skill 目录，供运行时拼接。
   * 缓存目录缺失的 skill 不返回（跨机迁移后由发现/更新补齐），并单独报告。
   */
  async resolveUserSkills(): Promise<{ paths: string[]; missing: string[] }> {
    const file = await this.#read()
    const paths: string[] = []
    const missing: string[] = []
    for (const skill of file.skills) {
      const directory = this.#skillDirectory(skill)
      if (existsSync(directory)) paths.push(directory)
      else missing.push(skill.name)
    }
    return { paths, missing }
  }

  async #cleanupUnusedCache(skills: InstalledSkill[]): Promise<void> {
    const used = new Set(skills.map((skill) => this.#cacheDirectoryFor(skill.sourceUrl, skill.ref)))
    for (const entry of await this.#readCacheEntries()) {
      if (!used.has(join(this.#cacheDirectory, entry.name))) {
        await rm(join(this.#cacheDirectory, entry.name), { recursive: true, force: true })
      }
    }
  }

  async #readCacheEntries(): Promise<{ name: string }[]> {
    try {
      return await readdir(this.#cacheDirectory, { withFileTypes: true })
    } catch {
      return []
    }
  }
}
