import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { validateToolRegistrations, type AizenToolRegistration } from "../../packages/core/tool-registry.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

function registration(name = "demo", classifierName = name): AizenToolRegistration {
  return {
    kind: "inProcess",
    descriptor: { name, label: name, description: "测试工具", parameters: { type: "object" } },
    classifier: {
      id: `user/demo@1`,
      toolNames: [classifierName],
      classify: async () => ({ kind: "claims", claims: [] }),
    },
    execute: async () => ({ content: [{ type: "text", text: "完成" }] }),
  }
}

test("联合注册允许不带分类器", () => {
  expect(
    validateToolRegistrations([
      {
        kind: "inProcess",
        descriptor: { name: "plain", label: "plain", description: "无分类器", parameters: { type: "object" } },
        execute: async () => ({ content: [{ type: "text", text: "完成" }] }),
      },
    ]),
  ).toBeUndefined()
})

test("联合注册要求分类器工具名匹配", () => {
  expect(() => validateToolRegistrations([registration("demo", "other")])).toThrow("分类器工具名不匹配")
})

test("联合注册拒绝重复工具名称", () => {
  expect(() => validateToolRegistrations([registration(), registration()])).toThrow("工具重复注册")
})

test("合法进程内工具注册不依赖 pi 类型", () => {
  expect(validateToolRegistrations([registration()])).toBeUndefined()
})
