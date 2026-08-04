import { readFile } from "node:fs/promises"
import { atomicWriteFile } from "./file-transaction.ts"
import type { ModelReference, ViewId } from "./session-format.ts"
import { permissionModes, type PermissionMode } from "./tool-permissions/types.ts"

export type AgentModelReference = {
  providerId: string
  modelId: string
}

export type AgentPreferences = {
  sessionNaming: {
    model?: AgentModelReference
  }
  permissionReview?: {
    model?: AgentModelReference
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
    permissionMode?: PermissionMode
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
  newSession: { viewId: null, permissionMode: "hybrid" },
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

function agentModelReference(value: unknown, label: string): AgentModelReference {
  const source = object(value, label)
  exact(source, ["providerId", "modelId"], label)
  for (const key of ["providerId", "modelId"] as const) {
    if (typeof source[key] !== "string" || !source[key]) throw new Error(`${label}.${key} 必须是非空字符串`)
  }
  return { providerId: source.providerId as string, modelId: source.modelId as string }
}

function permissionMode(value: unknown): PermissionMode {
  if (!permissionModes.includes(value as PermissionMode)) throw new Error("newSession.permissionMode 无效")
  return value as PermissionMode
}

function modelReference(value: unknown): ModelReference {
  const source = object(value, "newSession.model")
  exact(source, ["providerId", "modelId", "api", "thinkingLevel"], "newSession.model")
  for (const key of ["providerId", "modelId", "api"] as const) {
    if (typeof source[key] !== "string" || !source[key]) throw new Error(`newSession.model.${key} 必须是非空字符串`)
  }
  if (source.thinkingLevel !== undefined && (typeof source.thinkingLevel !== "string" || !source.thinkingLevel))
    throw new Error("newSession.model.thinkingLevel 必须是非空字符串")
  return {
    providerId: source.providerId as string,
    modelId: source.modelId as string,
    api: source.api as string,
    ...(source.thinkingLevel === undefined ? {} : { thinkingLevel: source.thinkingLevel as string }),
  }
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

/** 校验并规范化应用偏好，防止旧版本或无效配置进入核心和界面。 */
export function parseAppPreferences(value: unknown): AppPreferences {
  const source = object(value, "preferences.json")
  exact(source, ["newSession", "agents", "fold"], "preferences.json")
  const newSession = object(source.newSession, "newSession")
  exact(newSession, ["model", "viewId", "permissionMode"], "newSession")
  if (newSession.viewId !== null && typeof newSession.viewId !== "string")
    throw new Error("newSession.viewId 必须是字符串或 null")
  const agents = source.agents === undefined ? {} : object(source.agents, "agents")
  exact(agents, ["sessionNaming", "permissionReview"], "agents")
  const sessionNaming = agents.sessionNaming === undefined ? {} : object(agents.sessionNaming, "agents.sessionNaming")
  exact(sessionNaming, ["model"], "agents.sessionNaming")
  const permissionReview =
    agents.permissionReview === undefined ? {} : object(agents.permissionReview, "agents.permissionReview")
  exact(permissionReview, ["model"], "agents.permissionReview")
  return {
    newSession: {
      ...(newSession.model === undefined ? {} : { model: modelReference(newSession.model) }),
      viewId: newSession.viewId as ViewId,
      permissionMode: permissionMode(newSession.permissionMode ?? "hybrid"),
    },
    agents: {
      sessionNaming: {
        ...(sessionNaming.model === undefined
          ? {}
          : { model: agentModelReference(sessionNaming.model, "agents.sessionNaming.model") }),
      },
      ...(agents.permissionReview === undefined
        ? {}
        : {
            permissionReview: {
              ...(permissionReview.model === undefined
                ? {}
                : { model: agentModelReference(permissionReview.model, "agents.permissionReview.model") }),
            },
          }),
    },
    fold: foldPreferences(source.fold),
  }
}

export class AppPreferencesStore {
  readonly #file: string

  constructor(file: string) {
    this.#file = file
  }

  /** 读取应用偏好；文件不存在时返回内置默认值。 */
  async read(): Promise<AppPreferences> {
    try {
      return parseAppPreferences(JSON.parse(await readFile(this.#file, "utf8")))
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return structuredClone(defaultAppPreferences)
      throw new Error(`preferences.json 配置错误：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 原子写入经过校验的完整应用偏好。 */
  async write(value: AppPreferences): Promise<void> {
    const parsed = parseAppPreferences(value)
    await atomicWriteFile(this.#file, `${JSON.stringify(parsed, null, 2)}\n`)
  }
}
