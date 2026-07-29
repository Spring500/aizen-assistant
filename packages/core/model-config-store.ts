import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { atomicWriteFile } from "./file-transaction.ts"

export const configurableApis = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const

export type ConfigurableApi = (typeof configurableApis)[number]
export type ModelModality = "text" | "image" | "pdf" | "audio" | "video"
export type SupportedModelModality = "text" | "image"

export type ModelCostConfig = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type ModelThinkingConfig = {
  disableThinkingLevel?: string
  thinkingLevels: string[]
  defaultThinkingLevel: string
}

export type EditableModelConfig = {
  id: string
  name: string
  api?: ConfigurableApi
  thinking?: ModelThinkingConfig
  input: SupportedModelModality[]
  contextWindow: number
  maxTokens: number
  cost: ModelCostConfig
}

export type EditableProviderConfig = {
  id: string
  name: string
  baseUrl: string
  api: ConfigurableApi
  authHeader: boolean
}

export type ModelConfigEntry = EditableModelConfig & { editable: boolean; readonlyReason?: string }
export type ProviderConfigEntry = {
  id: string
  name: string
  baseUrl: string
  api?: ConfigurableApi
  authHeader: boolean
  editable: boolean
  readonlyReason?: string
  models: ModelConfigEntry[]
}

export type ModelConfigSnapshot = {
  revision: string
  providers: ProviderConfigEntry[]
  apiChoices: ConfigurableApi[]
  inputModalities: Array<{ value: ModelModality; enabled: boolean; disabledReason?: string }>
  outputModalities: Array<{ value: ModelModality; enabled: boolean; disabledReason?: string }>
}

type JsonObject = Record<string, unknown>
type StoredConfig = { providers: Record<string, JsonObject> }

const providerIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as JsonObject
}

function stripJsonComments(source: string): string {
  let output = ""
  let string = false
  let escaped = false
  for (let index = 0; index < source.length; index++) {
    const current = source[index] ?? ""
    const next = source[index + 1]
    if (string) {
      output += current
      if (escaped) escaped = false
      else if (current === "\\") escaped = true
      else if (current === '"') string = false
      continue
    }
    if (current === '"') {
      string = true
      output += current
    } else if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++
      output += "\n"
    } else if (current === "/" && next === "*") {
      index += 2
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index++
      index++
    } else output += current
  }
  return output
}

function parseConfig(source: string): StoredConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonComments(source))
  } catch (error) {
    throw new Error(`models.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const root = object(parsed, "models.json")
  const providers = object(root.providers, "models.json.providers")
  return { providers: providers as Record<string, JsonObject> }
}

function revision(source: string): string {
  return createHash("sha256").update(source).digest("hex")
}

function api(value: unknown, label: string): ConfigurableApi {
  if (!configurableApis.includes(value as ConfigurableApi)) throw new Error(`${label} 不是支持的 API`)
  return value as ConfigurableApi
}

function positiveInteger(value: unknown, label: string, fallback: number): number {
  const actual = value === undefined ? fallback : value
  if (!Number.isSafeInteger(actual) || Number(actual) <= 0) throw new Error(`${label} 必须是正整数`)
  return Number(actual)
}

function cost(value: unknown, label: string): ModelCostConfig {
  const source = value === undefined ? {} : object(value, label)
  const result = {
    input: source.input ?? 0,
    output: source.output ?? 0,
    cacheRead: source.cacheRead ?? 0,
    cacheWrite: source.cacheWrite ?? 0,
  }
  for (const [key, item] of Object.entries(result))
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0)
      throw new Error(`${label}.${key} 必须是非负有限数`)
  return result as ModelCostConfig
}

function validateProvider(input: EditableProviderConfig): void {
  if (!providerIdPattern.test(input.id))
    throw new Error("供应商 ID 只能包含小写字母、数字、点、下划线和短横线，长度不超过 64")
  if (!input.name.trim()) throw new Error("供应商名称不能为空")
  let parsed: URL
  try {
    parsed = new URL(input.baseUrl)
  } catch {
    throw new Error("Base URL 必须是合法的绝对 URL")
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Base URL 只能使用 HTTP/HTTPS，且不能包含认证信息、查询参数或片段")
  api(input.api, "供应商 API")
}

const invalidThinkingCharacter = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const maxThinkingLevelLength = 50

function normalizeThinkingLevel(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label}不能为空`)
  if (invalidThinkingCharacter.test(normalized)) throw new Error(`${label}不能包含控制字符或异常不可见字符`)
  if (Array.from(normalized).length > maxThinkingLevelLength)
    throw new Error(`${label}不能超过 ${maxThinkingLevelLength} 个字符`)
  return normalized
}

function normalizeThinking(input: ModelThinkingConfig | undefined): ModelThinkingConfig | undefined {
  if (!input) return undefined
  const disableThinkingLevel =
    input.disableThinkingLevel === undefined
      ? undefined
      : normalizeThinkingLevel(input.disableThinkingLevel, "关闭思考档位名")
  if (!Array.isArray(input.thinkingLevels) || input.thinkingLevels.length === 0) throw new Error("思考档位名不能为空")
  if (input.thinkingLevels.length > 6) throw new Error("开启思考最多支持六个档位")
  const thinkingLevels = input.thinkingLevels.map((value) => normalizeThinkingLevel(value, "思考档位名"))
  const values = [...(disableThinkingLevel === undefined ? [] : [disableThinkingLevel]), ...thinkingLevels]
  if (new Set(values).size !== values.length) throw new Error("思考档位名不能重复")
  const defaultThinkingLevel = normalizeThinkingLevel(input.defaultThinkingLevel, "默认思考档位")
  if (!values.includes(defaultThinkingLevel)) throw new Error("默认思考档位必须存在于合法档位集合")
  return {
    ...(disableThinkingLevel === undefined ? {} : { disableThinkingLevel }),
    thinkingLevels,
    defaultThinkingLevel,
  }
}

function validateModel(input: EditableModelConfig): void {
  if (
    !input.id.trim() ||
    input.id !== input.id.trim() ||
    [...input.id].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 || code === 127
    })
  )
    throw new Error("模型 ID 不能为空、包含首尾空格或控制字符")
  if (!input.name.trim()) throw new Error("模型名称不能为空")
  if (input.api !== undefined) api(input.api, "模型 API")
  normalizeThinking(input.thinking)
  if (input.input.length === 0 || new Set(input.input).size !== input.input.length)
    throw new Error("输入模态不能为空或重复")
  if (input.input.some((item) => item !== "text" && item !== "image"))
    throw new Error("当前 adapter 只支持文本和图片输入")
  positiveInteger(input.contextWindow, "上下文窗口", 128000)
  positiveInteger(input.maxTokens, "最大输出 token", 16384)
  if (input.maxTokens > input.contextWindow) throw new Error("最大输出 token 不能超过上下文窗口")
  cost(input.cost, "模型价格")
}

function optionalThinkingString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`)
  const normalized = normalizeThinkingLevel(value, label)
  if (normalized !== value) throw new Error(`${label} 不能包含首尾空格`)
  return normalized
}

function thinkingConfig(source: JsonObject): ModelThinkingConfig | undefined {
  if (
    source.thinkingLevels === undefined ||
    (Array.isArray(source.thinkingLevels) && source.thinkingLevels.length === 0)
  ) {
    if (source.disableThinkingLevel !== undefined || source.defaultThinkingLevel !== undefined)
      throw new Error("未配置思考档位名时不能配置关闭或默认档位")
    return undefined
  }
  if (!Array.isArray(source.thinkingLevels)) throw new Error("thinkingLevels 必须是数组")
  const disableThinkingLevel = optionalThinkingString(source.disableThinkingLevel, "disableThinkingLevel")
  const thinking: ModelThinkingConfig = {
    ...(disableThinkingLevel === undefined ? {} : { disableThinkingLevel }),
    thinkingLevels: source.thinkingLevels.map((value, index) => {
      if (typeof value !== "string") throw new Error(`thinkingLevels[${index}] 必须是字符串`)
      return optionalThinkingString(value, `thinkingLevels[${index}]`) ?? ""
    }),
    defaultThinkingLevel: optionalThinkingString(source.defaultThinkingLevel, "defaultThinkingLevel") ?? "",
  }
  return normalizeThinking(thinking)
}

function modelEntry(providerId: string, value: unknown): ModelConfigEntry {
  const source = object(value, `供应商 ${providerId} 的模型`)
  const id = typeof source.id === "string" ? source.id : ""
  const input = source.input === undefined ? ["text"] : source.input
  if (!Array.isArray(input)) throw new Error(`模型 ${providerId}/${id} 的 input 必须是数组`)
  const unsupported = input.filter((item) => item !== "text" && item !== "image")
  const modelApi =
    source.api === undefined
      ? undefined
      : configurableApis.includes(source.api as ConfigurableApi)
        ? (source.api as ConfigurableApi)
        : undefined
  const unsupportedApi = source.api !== undefined && modelApi === undefined
  const thinking = thinkingConfig(source)
  const entry: ModelConfigEntry = {
    id,
    name: typeof source.name === "string" ? source.name : id,
    ...(modelApi === undefined ? {} : { api: modelApi }),
    ...(thinking === undefined ? {} : { thinking }),
    input: input.filter((item): item is SupportedModelModality => item === "text" || item === "image"),
    contextWindow: positiveInteger(source.contextWindow, `模型 ${providerId}/${id} 的上下文窗口`, 128000),
    maxTokens: positiveInteger(source.maxTokens, `模型 ${providerId}/${id} 的最大输出 token`, 16384),
    cost: cost(source.cost, `模型 ${providerId}/${id} 的价格`),
    editable: unsupported.length === 0 && !unsupportedApi,
    ...(unsupported.length > 0
      ? { readonlyReason: `包含当前 adapter 不支持的输入模态：${unsupported.join("、")}` }
      : unsupportedApi
        ? { readonlyReason: `使用当前编辑器不支持的 API：${String(source.api)}` }
        : {}),
  }
  if (entry.maxTokens > entry.contextWindow) throw new Error(`模型 ${providerId}/${id} 的最大输出 token 超过上下文窗口`)
  return entry
}

function snapshot(config: StoredConfig, source: string): ModelConfigSnapshot {
  const providers = Object.entries(config.providers).map(([id, value]) => {
    const provider = object(value, `供应商 ${id}`)
    const models = provider.models === undefined ? [] : provider.models
    if (!Array.isArray(models)) throw new Error(`供应商 ${id} 的 models 必须是数组`)
    const providerApi = configurableApis.includes(provider.api as ConfigurableApi)
      ? (provider.api as ConfigurableApi)
      : undefined
    const editable = providerApi !== undefined && typeof provider.baseUrl === "string" && Array.isArray(provider.models)
    const entry: ProviderConfigEntry = {
      id,
      name: typeof provider.name === "string" ? provider.name : id,
      baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "",
      ...(providerApi === undefined ? {} : { api: providerApi }),
      authHeader: provider.authHeader === true,
      editable,
      ...(editable ? {} : { readonlyReason: "该供应商是内置覆盖或包含当前编辑器不支持的配置" }),
      models: models.map((model) => modelEntry(id, model)),
    }
    return entry
  })
  const unsupported = (value: ModelModality) => ({ value, enabled: false, disabledReason: "当前 pi adapter 不支持" })
  return {
    revision: revision(source),
    providers,
    apiChoices: [...configurableApis],
    inputModalities: [
      { value: "text", enabled: true },
      { value: "image", enabled: true },
      unsupported("pdf"),
      unsupported("audio"),
      unsupported("video"),
    ],
    outputModalities: [
      unsupported("text"),
      unsupported("image"),
      unsupported("pdf"),
      unsupported("audio"),
      unsupported("video"),
    ],
  }
}

export class ModelConfigStore {
  readonly #path: string
  constructor(path: string) {
    this.#path = path
  }

  async read(): Promise<ModelConfigSnapshot> {
    const source = await this.#readSource()
    return snapshot(parseConfig(source), source)
  }

  async upsertProvider(
    expectedRevision: string,
    provider: EditableProviderConfig,
    mode: "create" | "update" | "upsert" = "upsert",
  ): Promise<string> {
    validateProvider(provider)
    return this.#update(expectedRevision, (config) => {
      const exists = config.providers[provider.id] !== undefined
      if (mode === "create" && exists) throw new Error(`供应商 ID 已存在：${provider.id}`)
      if (mode === "update" && !exists) throw new Error(`供应商不存在：${provider.id}`)
      const previous = config.providers[provider.id] ?? {}
      config.providers[provider.id] = {
        ...previous,
        name: provider.name.trim(),
        baseUrl: provider.baseUrl,
        api: provider.api,
        authHeader: provider.authHeader,
        models: previous.models ?? [],
      }
    })
  }

  async deleteProvider(expectedRevision: string, providerId: string): Promise<string> {
    return this.#update(expectedRevision, (config) => {
      if (!config.providers[providerId]) throw new Error(`供应商不存在：${providerId}`)
      delete config.providers[providerId]
    })
  }

  async upsertModel(
    expectedRevision: string,
    providerId: string,
    model: EditableModelConfig,
    mode: "create" | "update" | "upsert" = "upsert",
  ): Promise<string> {
    validateModel(model)
    return this.#update(expectedRevision, (config) => {
      const provider = config.providers[providerId]
      if (!provider) throw new Error(`供应商不存在：${providerId}`)
      const models = Array.isArray(provider.models) ? [...provider.models] : []
      const index = models.findIndex((item) => object(item, "模型").id === model.id)
      if (mode === "create" && index >= 0) throw new Error(`模型 ID 已存在：${providerId}/${model.id}`)
      if (mode === "update" && index < 0) throw new Error(`模型不存在：${providerId}/${model.id}`)
      const previous = index < 0 ? {} : object(models[index], "模型")
      const thinking = normalizeThinking(model.thinking)
      const stored: JsonObject = {
        ...previous,
        id: model.id,
        name: model.name.trim(),
        ...(model.api === undefined ? { api: undefined } : { api: model.api }),
        ...(thinking
          ? {
              ...(thinking.disableThinkingLevel === undefined
                ? {}
                : { disableThinkingLevel: thinking.disableThinkingLevel }),
              thinkingLevels: [...thinking.thinkingLevels],
              defaultThinkingLevel: thinking.defaultThinkingLevel,
            }
          : {}),
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        cost: { ...model.cost },
      }
      if (stored.api === undefined) delete stored.api
      for (const key of [
        "reasoning",
        "thinkingLevelMap",
        "aizenThinkingDefault",
        "disableThinkingLevel",
        "thinkingLevels",
        "defaultThinkingLevel",
      ])
        delete stored[key]
      if (thinking) {
        if (thinking.disableThinkingLevel !== undefined) stored.disableThinkingLevel = thinking.disableThinkingLevel
        stored.thinkingLevels = [...thinking.thinkingLevels]
        stored.defaultThinkingLevel = thinking.defaultThinkingLevel
      }
      if (index < 0) models.push(stored)
      else models[index] = stored
      provider.models = models
    })
  }

  async deleteModel(expectedRevision: string, providerId: string, modelId: string): Promise<string> {
    return this.#update(expectedRevision, (config) => {
      const provider = config.providers[providerId]
      if (!provider || !Array.isArray(provider.models)) throw new Error(`供应商不存在：${providerId}`)
      const models = provider.models.filter((item) => object(item, "模型").id !== modelId)
      if (models.length === provider.models.length) throw new Error(`模型不存在：${providerId}/${modelId}`)
      provider.models = models
    })
  }

  async restore(source: string): Promise<void> {
    await this.#writeSource(source)
  }

  async source(): Promise<string> {
    return this.#readSource()
  }

  async #update(expectedRevision: string, mutate: (config: StoredConfig) => void): Promise<string> {
    const source = await this.#readSource()
    if (revision(source) !== expectedRevision) throw new Error("模型配置已被其他程序修改，请重新加载")
    const config = structuredClone(parseConfig(source))
    mutate(config)
    const next = `${JSON.stringify(config, null, 2)}\n`
    snapshot(config, next)
    await this.#writeSource(next)
    return next
  }

  async #readSource(): Promise<string> {
    try {
      return await readFile(this.#path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return '{\n  "providers": {}\n}\n'
      throw error
    }
  }

  async #writeSource(source: string): Promise<void> {
    await atomicWriteFile(this.#path, source)
  }
}
