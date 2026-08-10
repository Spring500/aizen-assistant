import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { validateToolRegistrations, type AizenToolRegistration } from "../../packages/core/tool-registry.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

function registration(name = "demo", validatorName = name): AizenToolRegistration {
  return {
    kind: "inProcess",
    descriptor: { name, label: name, description: "测试工具", parameters: { type: "object" } },
    validator: {
      toolName: validatorName,
      validate: async () => ({
        type: "allow",
        assessment: { summary: name, targets: [], reason: "测试" },
      }),
    },
    execute: async () => ({ content: [{ type: "text", text: "完成" }] }),
  }
}

test("联合注册要求工具和验证器名称一致", () => {
  expect(() => validateToolRegistrations([registration("demo", "other")])).toThrow("验证器名称不匹配")
})

test("联合注册拒绝重复工具名称", () => {
  expect(() => validateToolRegistrations([registration(), registration()])).toThrow("工具重复注册")
})

test("合法进程内工具注册不依赖 pi 类型", () => {
  expect(validateToolRegistrations([registration()])).toBeUndefined()
})
