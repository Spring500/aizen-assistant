import { expect } from "bun:test"
import { checkStorageIsolation } from "../../scripts/repo/check-storage-isolation.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

test("拒绝未登记的文件系统入口", async () => {
  const errors = await checkStorageIsolation({
    "packages/core/new-feature.ts": 'import { readFile } from "node:fs/promises"\nvoid readFile',
  })
  expect(errors).toContain("packages/core/new-feature.ts 直接访问文件系统但未登记")
})

test("拒绝未登记 Store 和绕过组合根的构造", async () => {
  const errors = await checkStorageIsolation({
    "packages/core/new-store.ts": "export class ExampleStore {}",
    "apps/tui/new-feature.ts": "const store = new SessionStore(path)",
  })
  expect(errors.some((error) => error.includes("ExampleStore 未登记"))).toBe(true)
  expect(errors.some((error) => error.includes("直接构造 SessionStore"))).toBe(true)
})
