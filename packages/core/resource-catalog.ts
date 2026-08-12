/** 持久化资源条目的总体状态；具体行为必须读取 capabilities，不能由状态或错误码推断。 */
export type EntryState = "healthy" | "degraded" | "unavailable"

export type ResourceIssueCategory = "syntax" | "integrity" | "incomplete" | "conflict" | "io" | "availability"

export type ResourceIssueDefinition = {
  category: ResourceIssueCategory
  label: string
}

export type ResourceIssue = ResourceIssueDefinition & {
  code: string
  message: string
}

/** 交互层只能依据这些能力决定可用操作。 */
export type ResourceCapabilities = {
  canOpen: boolean
  canWrite: boolean
  canForceOpen: boolean
  canRecover: boolean
}

export type CatalogEntry = {
  entryId: string
  state: EntryState
  issues: ResourceIssue[]
  capabilities: ResourceCapabilities
}

export type CatalogResult<T extends CatalogEntry> = {
  entries: T[]
  issues: ResourceIssue[]
}

type IssueDefinitions = Record<string, ResourceIssueDefinition>

/**
 * 同一张定义表同时提供编译期 code 联合类型和运行时校验。
 * RPC、插件或磁盘反序列化得到的 code 必须先经过 has()，业务内部则通过 create() 创建。
 */
export function defineIssues<const Definitions extends IssueDefinitions>(definitions: Definitions) {
  type Code = Extract<keyof Definitions, string>
  const codes = new Set(Object.keys(definitions))
  return {
    definitions,
    has(code: string): code is Code {
      return codes.has(code)
    },
    create<C extends Code>(code: C, message: string): ResourceIssue & { code: C } {
      const definition = definitions[code] as ResourceIssueDefinition
      return { code, ...definition, message }
    },
  }
}

export const healthyCapabilities: ResourceCapabilities = {
  canOpen: true,
  canWrite: true,
  canForceOpen: false,
  canRecover: false,
}
