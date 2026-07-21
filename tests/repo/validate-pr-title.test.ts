import { describe, expect, test } from "bun:test"
import { validatePrTitle } from "../../scripts/repo/validate-pr-title.ts"

describe("validatePrTitle", () => {
  test("接受约定格式和中文说明", () => {
    expect(validatePrTitle("feat(tui): 支持备用屏幕重绘")).toBeUndefined()
    expect(validatePrTitle("build(pi)!: 升级并迁移会话接口")).toBeUndefined()
  })

  test("拒绝未知类型、未知范围和纯英文说明", () => {
    expect(validatePrTitle("feature(tui): 新功能")).toBe("PR 标题不符合 Conventional Commits")
    expect(validatePrTitle("feat(unknown): 新功能")).toBe("PR 标题不符合 Conventional Commits")
    expect(validatePrTitle("feat(tui): add redraw")).toBe("PR 标题说明必须包含中文")
  })
})
