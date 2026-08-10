import { mockDslBehavior } from "./behaviors/mock-dsl.ts"
import { mockNamingBehavior } from "./behaviors/mock-naming.ts"
import { mockReviewBehavior } from "./behaviors/mock-review.ts"
import type { MockBehavior } from "./types.ts"

export const mockBehaviorIds = ["dsl", "naming", "review", "test-control"] as const
export type MockBehaviorId = (typeof mockBehaviorIds)[number]

/** 内置模型 ID 到行为类型的默认映射。 */
export const defaultMockModelBehaviors: Record<string, Exclude<MockBehaviorId, "test-control">> = {
  "mock-dsl": "dsl",
  "mock-naming": "naming",
  "mock-review": "review",
}

/** 返回指定内置行为类型的实现；测试控制行为由 Server 在运行时创建。 */
export function builtinMockBehavior(behavior: Exclude<MockBehaviorId, "test-control">): MockBehavior {
  if (behavior === "dsl") return mockDslBehavior
  if (behavior === "naming") return mockNamingBehavior
  return mockReviewBehavior
}

/** 返回默认内置模型 ID，供套件诊断使用。 */
export function registeredMockModelIds(): string[] {
  return Object.keys(defaultMockModelBehaviors).sort()
}
