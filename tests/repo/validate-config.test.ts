import { describe, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { validatePackageConfig, validatePrivatePaths } from "../../scripts/repo/validate-config.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

describe("validatePackageConfig", () => {
  test("接受精确版本和内部 workspace 协议", () => {
    expect(
      validatePackageConfig({
        packageManager: "bun@1.3.13",
        dependencies: { alpha: "1.2.3", "@aizen/core": "workspace:*" },
        devDependencies: { beta: "4.5.6" },
      }),
    ).toEqual([])
  })

  test("拒绝范围版本", () => {
    expect(
      validatePackageConfig({
        packageManager: "bun@1.3.13",
        dependencies: { alpha: "^1.2.3" },
        devDependencies: { beta: "~4.5.6" },
      }),
    ).toEqual(["dependencies.alpha 必须锁定精确版本", "devDependencies.beta 必须锁定精确版本"])
  })
})

describe("validatePrivatePaths", () => {
  test("拒绝索引中的私有目录和设计文档", () => {
    expect(validatePrivatePaths([".private/plan.html", "docs/design/spec.html", "方案与路线图.md"])).toEqual([
      ".private/plan.html 不得进入 Git",
      "docs/design/spec.html 不得进入 Git",
      "方案与路线图.md 不得进入 Git",
    ])
  })
})
