import { readFile } from "node:fs/promises"
import { atomicWriteFile } from "./file-transaction.ts"
import type { ModelReference, ViewId } from "./session-format.ts"

export type AgentModelReference = {
  providerId: string
  modelId: string
}

export type AgentPreferences = {
  sessionNaming: {
    model?: AgentModelReference
  }
}

export type FoldPreferences = {
  userTurns: number
  assistantTurns: number
  thinkingTurns: number
  toolGroupTurns: number
  toolDetailTurns: number
}

export type AppPreferences = {
  version: 1
  newSession: {
    model?: ModelReference
    viewId: ViewId
  }
  agents: AgentPreferences
  fold: FoldPreferences
}

export const defaultFoldPreferences: FoldPreferences = {
  userTurns: 0,
  assistantTurns: 3,
  thinkingTurns: 1,
  toolGroupTurns: 1,
  toolDetailTurns: 1,
}

export const defaultAppPreferences: AppPreferences = {
  version: 1,
  newSession: { viewId: null },
  agents: { sessionNaming: {} },
  fold: defaultFoldPreferences,
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label} 包含未知字段：${key}`)
}

function turns(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} 必须是非负安全整数`)
  return value as number
}

function agentModelReference(value: unknown): AgentModelReference {
  const source = object(value, "agents.sessionNaming.model")
  exact(source, ["providerId", "modelId"], "agents.sessionNaming.model")
  for (const key of ["providerId", "modelId"] as const) {
    if (typeof source[key] !== "string" || !source[key])
      throw new Error(`agents.sessionNaming.model.${key} 必须是非空字符串`)
  }
  return { providerId: source.providerId as string, modelId: source.modelId as string }
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

/** 校验并规范化应用偏好，防止无效配置进入核心和界面。 */
export function parseAppPreferences(value: unknown): AppPreferences {
  const source = object(value, "preferences.json")
  exact(source, ["version", "newSession", "agents", "fold"], "preferences.json")
  if (source.version !== 1) throw new Error(`不支持的 preferences.json 版本：${String(source.version)}`)
  const newSession = object(source.newSession, "newSession")
  exact(newSession, ["model", "viewId"], "newSession")
  if (newSession.viewId !== null && typeof newSession.viewId !== "string")
    throw new Error("newSession.viewId 必须是字符串或 null")
  const agents = source.agents === undefined ? {} : object(source.agents, "agents")
  exact(agents, ["sessionNaming"], "agents")
  const sessionNaming = agents.sessionNaming === undefined ? {} : object(agents.sessionNaming, "agents.sessionNaming")
  exact(sessionNaming, ["model"], "agents.sessionNaming")
  const fold = object(source.fold, "fold")
  exact(fold, ["userTurns", "assistantTurns", "thinkingTurns", "toolGroupTurns", "toolDetailTurns"], "fold")
  const parsedFold: FoldPreferences = {
    userTurns: turns(fold.userTurns, "fold.userTurns"),
    assistantTurns: turns(fold.assistantTurns, "fold.assistantTurns"),
    thinkingTurns: turns(fold.thinkingTurns, "fold.thinkingTurns"),
    toolGroupTurns: turns(fold.toolGroupTurns, "fold.toolGroupTurns"),
    toolDetailTurns: turns(fold.toolDetailTurns, "fold.toolDetailTurns"),
  }
  if (
    parsedFold.toolDetailTurns === 0
      ? parsedFold.toolGroupTurns !== 0
      : parsedFold.toolGroupTurns !== 0 && parsedFold.toolDetailTurns > parsedFold.toolGroupTurns
  )
    throw new Error("工具详情展开轮次不能大于工具组")
  return {
    version: 1,
    newSession: {
      ...(newSession.model === undefined ? {} : { model: modelReference(newSession.model) }),
      viewId: newSession.viewId as ViewId,
    },
    agents: {
      sessionNaming: {
        ...(sessionNaming.model === undefined ? {} : { model: agentModelReference(sessionNaming.model) }),
      },
    },
    fold: parsedFold,
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
