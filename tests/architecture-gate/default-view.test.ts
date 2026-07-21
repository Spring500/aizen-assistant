import { expect, test } from "bun:test"
import { DEFAULT_VIEW } from "../../apps/architecture-gate/src/default-view.ts"

test("内置视图以文本资源导入", () => {
  expect(DEFAULT_VIEW).toContain("AizenAssistant 架构门禁")
  expect(DEFAULT_VIEW).toContain("仅用于验证内置资源嵌入")
})
