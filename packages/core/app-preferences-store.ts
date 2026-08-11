import { readFile } from "node:fs/promises"
import { atomicWriteFile } from "./file-transaction.ts"
import { parseModelReference, type ModelReference, type ViewId } from "./session-format.ts"
import {
  type PermissionPresetId,
  type PermissionReviewMode,
  permissionPresetIds,
  permissionReviewModes,
} from "./tool-permissions/policy-types.ts"

export type AgentPreferences = {
  sessionNaming: {
    model?: ModelReference
  }
  permissionReview?: {
    model?: ModelReference
  }
}

export type FoldPreferences = {
  thinkingExpanded: boolean
  toolGroupExpanded: boolean
  toolDetailsExpanded: boolean
}

export type AppPreferences = {
  newSession: {
    model?: ModelReference
    viewId: ViewId
    permissionPreset?: PermissionPresetId
    permissionReviewMode?: PermissionReviewMode
  }
  agents: AgentPreferences
  fold: FoldPreferences
}

export const defaultFoldPreferences: FoldPreferences = {
  thinkingExpanded: false,
  toolGroupExpanded: false,
  toolDetailsExpanded: false,
}

export const defaultAppPreferences: AppPreferences = {
  newSession: {
    viewId: null,
    permissionPreset: "edit",
    permissionReviewMode: "manual",
  },
  agents: { sessionNaming: {}, permissionReview: {} },
  fold: defaultFoldPreferences,
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label} 包含未知字段：${key}`)
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`)
  return value
}

function permissionPreset(value: unknown): PermissionPresetId {
  if (!permissionPresetIds.includes(value as PermissionPresetId)) throw new Error("newSession.permissionPreset 无效")
  return value as PermissionPresetId
}

function permissionReviewMode(value: unknown): PermissionReviewMode {
  if (!permissionReviewModes.includes(value as PermissionReviewMode))
    throw new Error("newSession.permissionReviewMode 无效")
  return value as PermissionReviewMode
}

function foldPreferences(value: unknown): FoldPreferences {
  const fold = object(value, "fold")
  exact(fold, ["thinkingExpanded", "toolGroupExpanded", "toolDetailsExpanded"], "fold")
  return {
    thinkingExpanded: booleanValue(fold.thinkingExpanded, "fold.thinkingExpanded"),
    toolGroupExpanded: booleanValue(fold.toolGroupExpanded, "fold.toolGroupExpanded"),
    toolDetailsExpanded: booleanValue(fold.toolDetailsExpanded, "fold.toolDetailsExpanded"),
  }
}

/** 严格校验准备写入的完整应用偏好，防止无效数据落盘。 */
export function parseAppPreferences(value: unknown): AppPreferences {
  const source = object(value, "preferences.json")
  exact(source, ["newSession", "agents", "fold"], "preferences.json")
  const newSession = object(source.newSession, "newSession")
  exact(newSession, ["model", "viewId", "permissionPreset", "permissionReviewMode"], "newSession")
  if (newSession.viewId !== null && typeof newSession.viewId !== "string")
    throw new Error("newSession.viewId 必须是字符串或 null")
  const agents = object(source.agents, "agents")
  exact(agents, ["sessionNaming", "permissionReview"], "agents")
  const sessionNaming = object(agents.sessionNaming, "agents.sessionNaming")
  exact(sessionNaming, ["model"], "agents.sessionNaming")
  const permissionReview = object(agents.permissionReview, "agents.permissionReview")
  exact(permissionReview, ["model"], "agents.permissionReview")
  return {
    newSession: {
      ...(newSession.model === undefined ? {} : { model: parseModelReference(newSession.model, "newSession.model") }),
      viewId: newSession.viewId as ViewId,
      permissionPreset:
        newSession.permissionPreset === undefined ? "edit" : permissionPreset(newSession.permissionPreset),
      permissionReviewMode:
        newSession.permissionReviewMode === undefined
          ? "manual"
          : permissionReviewMode(newSession.permissionReviewMode),
    },
    agents: {
      sessionNaming: {
        ...(sessionNaming.model === undefined
          ? {}
          : { model: parseModelReference(sessionNaming.model, "agents.sessionNaming.model") }),
      },
      permissionReview: {
        ...(permissionReview.model === undefined
          ? {}
          : { model: parseModelReference(permissionReview.model, "agents.permissionReview.model") }),
      },
    },
    fold: foldPreferences(source.fold),
  }
}

function issue(warnings: string[], message: string): void {
  warnings.push(`${message}，已使用默认值`)
}

function unknownFields(
  source: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  warnings: string[],
): void {
  for (const key of Object.keys(source)) if (!keys.includes(key)) warnings.push(`${label}.${key} 是未知字段，已忽略`)
}

function recordOrDefault(value: unknown, label: string, warnings: string[]): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  issue(warnings, value === undefined ? `${label} 缺失` : `${label} 必须是对象`)
  return undefined
}

function field<T>(value: unknown, label: string, fallback: T, warnings: string[], parse: (value: unknown) => T): T {
  if (value === undefined) {
    issue(warnings, `${label} 缺失`)
    return fallback
  }
  try {
    return parse(value)
  } catch (error) {
    issue(warnings, error instanceof Error ? error.message : String(error))
    return fallback
  }
}

function readStoredPreferences(value: unknown): { preferences: AppPreferences; warnings: string[] } {
  const warnings: string[] = []
  const defaults = structuredClone(defaultAppPreferences)
  const source = recordOrDefault(value, "preferences.json", warnings)
  if (!source) return { preferences: defaults, warnings }
  unknownFields(source, ["newSession", "agents", "fold"], "preferences.json", warnings)

  const newSession = recordOrDefault(source.newSession, "newSession", warnings)
  if (newSession) {
    unknownFields(newSession, ["model", "viewId", "permissionPreset", "permissionReviewMode"], "newSession", warnings)
    defaults.newSession.viewId = field(
      newSession.viewId,
      "newSession.viewId",
      defaults.newSession.viewId,
      warnings,
      (item) => {
        if (item !== null && typeof item !== "string") throw new Error("newSession.viewId 必须是字符串或 null")
        return item as ViewId
      },
    )
    defaults.newSession.permissionPreset = field(
      newSession.permissionPreset,
      "newSession.permissionPreset",
      defaults.newSession.permissionPreset ?? "edit",
      warnings,
      permissionPreset,
    )
    defaults.newSession.permissionReviewMode = field(
      newSession.permissionReviewMode,
      "newSession.permissionReviewMode",
      defaults.newSession.permissionReviewMode ?? "manual",
      warnings,
      permissionReviewMode,
    )
    if (newSession.model !== undefined) {
      try {
        defaults.newSession.model = parseModelReference(newSession.model, "newSession.model")
      } catch (error) {
        issue(warnings, error instanceof Error ? error.message : String(error))
      }
    }
  }

  const agents = recordOrDefault(source.agents, "agents", warnings)
  if (agents) {
    unknownFields(agents, ["sessionNaming", "permissionReview"], "agents", warnings)
    const sessionNaming = recordOrDefault(agents.sessionNaming, "agents.sessionNaming", warnings)
    if (sessionNaming) {
      unknownFields(sessionNaming, ["model"], "agents.sessionNaming", warnings)
      if (sessionNaming.model !== undefined) {
        try {
          defaults.agents.sessionNaming.model = parseModelReference(sessionNaming.model, "agents.sessionNaming.model")
        } catch (error) {
          issue(warnings, error instanceof Error ? error.message : String(error))
        }
      }
    }
    const permissionReview = recordOrDefault(agents.permissionReview, "agents.permissionReview", warnings)
    if (permissionReview) {
      unknownFields(permissionReview, ["model"], "agents.permissionReview", warnings)
      if (permissionReview.model !== undefined) {
        try {
          defaults.agents.permissionReview = {
            model: parseModelReference(permissionReview.model, "agents.permissionReview.model"),
          }
        } catch (error) {
          issue(warnings, error instanceof Error ? error.message : String(error))
        }
      }
    }
  }

  const fold = recordOrDefault(source.fold, "fold", warnings)
  if (fold) {
    unknownFields(fold, ["thinkingExpanded", "toolGroupExpanded", "toolDetailsExpanded"], "fold", warnings)
    defaults.fold.thinkingExpanded = field(
      fold.thinkingExpanded,
      "fold.thinkingExpanded",
      defaults.fold.thinkingExpanded,
      warnings,
      (item) => booleanValue(item, "fold.thinkingExpanded"),
    )
    defaults.fold.toolGroupExpanded = field(
      fold.toolGroupExpanded,
      "fold.toolGroupExpanded",
      defaults.fold.toolGroupExpanded,
      warnings,
      (item) => booleanValue(item, "fold.toolGroupExpanded"),
    )
    defaults.fold.toolDetailsExpanded = field(
      fold.toolDetailsExpanded,
      "fold.toolDetailsExpanded",
      defaults.fold.toolDetailsExpanded,
      warnings,
      (item) => booleanValue(item, "fold.toolDetailsExpanded"),
    )
  }
  return { preferences: defaults, warnings }
}

export class AppPreferencesStore {
  readonly #file: string
  #warnings: string[] = []

  constructor(file: string) {
    this.#file = file
  }

  /** 逐字段读取应用偏好；无效字段使用默认值并记录警告。 */
  async read(): Promise<AppPreferences> {
    let value: unknown
    try {
      value = JSON.parse(await readFile(this.#file, "utf8"))
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        this.#warnings = []
        return structuredClone(defaultAppPreferences)
      }
      if (error instanceof SyntaxError) {
        this.#warnings = [`preferences.json 不是有效 JSON，已使用全部默认偏好：${error.message}`]
        return structuredClone(defaultAppPreferences)
      }
      throw new Error(`读取 preferences.json 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const parsed = readStoredPreferences(value)
    this.#warnings = parsed.warnings
    return parsed.preferences
  }

  /** 取出最近一次读取产生的配置警告。 */
  takeWarnings(): string[] {
    return this.#warnings.splice(0)
  }

  /** 原子写入经过严格校验的完整应用偏好。 */
  async write(value: AppPreferences): Promise<void> {
    const parsed = parseAppPreferences(value)
    await atomicWriteFile(this.#file, `${JSON.stringify(parsed, null, 2)}\n`)
  }
}
