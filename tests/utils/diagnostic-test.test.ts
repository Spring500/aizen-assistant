import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { expect } from "bun:test"
import { createDiagnosticTest } from "./diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

test("统一入口执行同步测试", () => {
  expect(1 + 1).toBe(2)
})

test("所有测试文件使用统一超时入口且不声明 Bun 超时", async () => {
  const root = join(import.meta.dir, "..")
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name.endsWith(".test.ts")) files.push(path)
    }
  }
  await visit(root)

  const legacyTimeoutPattern = /\},\s*\d[\d_]*\s*\)/
  for (const path of files) {
    const source = await Bun.file(path).text()
    expect(source).toContain("createDiagnosticTest")
    expect(source).not.toMatch(/import\s*{[^}]*\btest\b[^}]*}\s*from\s*["']bun:test["']/)
    if (path === import.meta.path) continue
    expect(source).not.toContain("setDefaultTimeout(")
    expect(source).not.toMatch(legacyTimeoutPattern)
  }
})
