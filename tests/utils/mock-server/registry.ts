import type { MockBehavior } from "./types.ts"

/** 内置模型行为注册表；新增模型必须显式登记，避免隐式目录扫描。 */
export const mockBehaviorRegistry: Record<string, MockBehavior> = {}

/** 返回已注册模型 ID，供未知模型错误提示和启动器诊断使用。 */
export function registeredMockModelIds(): string[] {
  return Object.keys(mockBehaviorRegistry).sort()
}
