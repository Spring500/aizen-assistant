import { describe, expect } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { readInstallRecord, writeInstallRecord } from "../../packages/core/install-record.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { removeTemporaryDirectory } from "../utils/temporary-directory.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

describe("install-record", () => {
  test("写入后能读回完整记录", async () => {
    const dir = await mkdtemp(join(tmpdir(), `install-record-${randomUUID()}`))
    try {
      const file = join(dir, "install.json")
      await writeInstallRecord({ channel: "github", version: "0.1.0", platform: "windows-x64" }, file)
      expect(await readInstallRecord(file)).toEqual({ channel: "github", version: "0.1.0", platform: "windows-x64" })
    } finally {
      await removeTemporaryDirectory(dir)
    }
  })

  test("文件不存在时返回 undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), `install-record-${randomUUID()}`))
    try {
      expect(await readInstallRecord(join(dir, "missing.json"))).toBeUndefined()
    } finally {
      await removeTemporaryDirectory(dir)
    }
  })

  test("无效 JSON 或字段缺失时返回 undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), `install-record-${randomUUID()}`))
    try {
      const invalid = join(dir, "invalid.json")
      await writeFile(invalid, "not json")
      expect(await readInstallRecord(invalid)).toBeUndefined()

      const wrongChannel = join(dir, "wrong-channel.json")
      await writeFile(wrongChannel, JSON.stringify({ channel: "unknown", version: "0.1.0", platform: "x" }))
      expect(await readInstallRecord(wrongChannel)).toBeUndefined()

      const missingFields = join(dir, "missing-fields.json")
      await writeFile(missingFields, JSON.stringify({ channel: "github" }))
      expect(await readInstallRecord(missingFields)).toBeUndefined()
    } finally {
      await removeTemporaryDirectory(dir)
    }
  })
})
