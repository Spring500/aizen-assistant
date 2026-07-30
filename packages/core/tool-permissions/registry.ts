import type { ToolPermissionValidator } from "./types.ts"

export class ToolPermissionRegistry {
  readonly #validators = new Map<string, ToolPermissionValidator>()

  /** 注册或替换指定工具的权限验证器。 */
  register(validator: ToolPermissionValidator): void {
    if (!validator.toolName) throw new Error("工具验证器名称不能为空")
    this.#validators.set(validator.toolName, validator)
  }

  /** 返回指定工具当前注册的权限验证器。 */
  get(toolName: string): ToolPermissionValidator | undefined {
    return this.#validators.get(toolName)
  }
}
