import { describe, expect } from "bun:test"
import { PermissionClassifierRegistry } from "../../../packages/core/tool-permissions/classifier-registry.ts"
import type { PermissionClassifier } from "../../../packages/core/tool-permissions/classifier-types.ts"
import { createDiagnosticTest } from "../../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

function classifier(id: string, toolNames: string[], tag: "read-workspace" | "network-fetch"): PermissionClassifier {
  return {
    id,
    toolNames,
    classify: () => ({ kind: "claims", claims: [{ tag, reason: `${id} 的判断` }] }),
  }
}

describe("权限分类器注册表", () => {
  test("同一工具的多个分类器取 claims 并集", async () => {
    const registry = new PermissionClassifierRegistry()
    registry.registerBuiltin(classifier("builtin/file@1", ["read"], "read-workspace"))
    registry.registerUser(classifier("user/network@1", ["read"], "network-fetch"))
    expect(
      await registry.classify(
        { toolName: "read", arguments: { path: "a" }, cwd: "/project" },
        {
          workspaceRoot: "/project",
          sensitivePaths: [],
          shell: "bash",
          platform: "linux",
        },
      ),
    ).toEqual({
      kind: "claims",
      claims: [
        { tag: "read-workspace", reason: "builtin/file@1 的判断", classifierId: "builtin/file@1" },
        { tag: "network-fetch", reason: "user/network@1 的判断", classifierId: "user/network@1" },
      ],
    })
  })

  test("全员弃权或没有匹配分类器时为 unknown", async () => {
    const registry = new PermissionClassifierRegistry()
    registry.registerBuiltin({ id: "builtin/empty@1", toolNames: ["bash"], classify: () => ({ kind: "abstain" }) })
    const context = { workspaceRoot: "/project", sensitivePaths: [], shell: "bash", platform: "linux" }
    expect(await registry.classify({ toolName: "bash", arguments: {}, cwd: "/project" }, context)).toEqual({
      kind: "unknown",
    })
    expect(await registry.classify({ toolName: "other", arguments: {}, cwd: "/project" }, context)).toEqual({
      kind: "unknown",
    })
  })

  test("claims 空数组是正面担保而不是弃权", async () => {
    const registry = new PermissionClassifierRegistry()
    registry.registerBuiltin({
      id: "builtin/no-side-effect@1",
      toolNames: ["todo"],
      classify: () => ({ kind: "claims", claims: [] }),
    })
    expect(
      await registry.classify(
        { toolName: "todo", arguments: {}, cwd: "/project" },
        { workspaceRoot: "/project", sensitivePaths: [], shell: "bash", platform: "linux" },
      ),
    ).toEqual({ kind: "claims", claims: [] })
  })

  test("用户分类器按相同 ID 完全替换内置分类器", async () => {
    const registry = new PermissionClassifierRegistry()
    registry.registerBuiltin(classifier("builtin/file@1", ["read"], "read-workspace"))
    registry.registerUser(classifier("builtin/file@1", ["read"], "network-fetch"))
    const result = await registry.classify(
      { toolName: "read", arguments: {}, cwd: "/project" },
      { workspaceRoot: "/project", sensitivePaths: [], shell: "bash", platform: "linux" },
    )
    expect(result).toEqual({
      kind: "claims",
      claims: [{ tag: "network-fetch", reason: "builtin/file@1 的判断", classifierId: "builtin/file@1" }],
    })
  })

  test("分类器异常按弃权处理且不影响其他断言", async () => {
    const registry = new PermissionClassifierRegistry()
    registry.registerBuiltin({
      id: "builtin/broken@1",
      toolNames: ["read"],
      classify: () => {
        throw new Error("失败")
      },
    })
    registry.registerUser(classifier("user/file@1", ["read"], "read-workspace"))
    const result = await registry.classify(
      { toolName: "read", arguments: {}, cwd: "/project" },
      { workspaceRoot: "/project", sensitivePaths: [], shell: "bash", platform: "linux" },
    )
    expect(result).toMatchObject({ kind: "claims", claims: [{ classifierId: "user/file@1" }] })
    expect(registry.takeErrors()).toEqual(["分类器 builtin/broken@1 执行失败：失败"])
  })
})
