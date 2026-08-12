export type ResourceIssueDefinition = {
  label: string
}

export type ResourceIssue = ResourceIssueDefinition & {
  code: string
  message: string
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
