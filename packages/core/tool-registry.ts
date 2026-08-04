import type { JsonValue } from "./session-format.ts"
import type { ToolPermissionValidator } from "./tool-permissions/types.ts"

export type AizenToolDescriptor = {
  name: string
  label: string
  description: string
  /** 与 JSON Schema 兼容的工具参数定义。 */
  parameters: JsonValue
  executionMode?: "parallel" | "sequential"
}

export type AizenToolContent = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string }

export type AizenToolResult = {
  content: AizenToolContent[]
  details?: JsonValue
}

export type AizenToolExecutionInput = {
  toolCallId: string
  cwd: string
  arguments: JsonValue
  signal?: AbortSignal
  onUpdate?: (result: AizenToolResult) => void
}

export type InProcessToolRegistration = {
  kind: "inProcess"
  descriptor: AizenToolDescriptor
  validator: ToolPermissionValidator
  execute(input: AizenToolExecutionInput): Promise<AizenToolResult>
}

export type AizenToolRegistration = InProcessToolRegistration

/** 校验联合注册项，确保工具描述、执行器和权限验证器绑定为同一名称。 */
export function validateToolRegistrations(registrations: AizenToolRegistration[]): void {
  const names = new Set<string>()
  for (const registration of registrations) {
    const name = registration.descriptor.name.trim()
    if (!name) throw new Error("工具名称不能为空")
    if (name !== registration.descriptor.name)
      throw new Error(`工具名称不能包含首尾空白：${registration.descriptor.name}`)
    if (registration.validator.toolName !== name)
      throw new Error(`工具 ${name} 的验证器名称不匹配：${registration.validator.toolName}`)
    if (names.has(name)) throw new Error(`工具重复注册：${name}`)
    names.add(name)
  }
}
