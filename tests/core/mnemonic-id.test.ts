import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { WordTripletIdGenerator } from "../../packages/core/mnemonic-id.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

test("助记 ID 使用主谓宾三段格式", () => {
  const values = [21, 0, 3]
  const generator = new WordTripletIdGenerator({ randomIndex: () => values.shift() ?? 0 })
  expect(generator.generate(() => false)).toBe("otter-builds-bridge")
})

test("助记 ID 冲突时重新生成", () => {
  const values = [21, 0, 3, 22, 1, 4]
  const generator = new WordTripletIdGenerator({ randomIndex: () => values.shift() ?? 0 })
  expect(generator.generate((candidate) => candidate === "otter-builds-bridge")).toBe("owl-carries-brook")
})
