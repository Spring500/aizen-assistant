import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeTemporaryDirectory } from "./temporary-directory.ts"

test("统一接口递归删除临时目录且重复删除视为成功", async () => {
  const path = join(tmpdir(), `aizen-remove-${crypto.randomUUID()}`)
  await mkdir(join(path, "nested"), { recursive: true })
  await writeFile(join(path, "nested", "file.txt"), "test")

  await removeTemporaryDirectory(path)
  expect(existsSync(path)).toBe(false)
  await removeTemporaryDirectory(path)
})

test("统一接口校验重试参数并支持短超时", async () => {
  const path = join(tmpdir(), `aizen-remove-${crypto.randomUUID()}`)
  await mkdir(path)
  await removeTemporaryDirectory(path, { timeoutMs: 50, intervalMs: 5 })
  expect(existsSync(path)).toBe(false)
})
