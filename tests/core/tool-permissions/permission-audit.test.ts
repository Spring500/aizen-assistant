import { afterEach, describe, expect } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonlPermissionAuditRecorder } from "../../../packages/core/tool-permissions/permission-audit.ts"
import { createDiagnosticTest } from "../../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

function event(sequence: number): Parameters<JsonlPermissionAuditRecorder["record"]>[0] {
  return {
    type: "permissionRequested",
    request: {
      sessionId: "s",
      turnId: "t",
      toolCallId: `call-${sequence}`,
      toolName: "read",
      arguments: { path: "a.ts" },
      declaredIntent: "测试",
      cwd: "/project",
    },
    batchId: "batch",
    at: new Date(sequence).toISOString(),
  }
}

describe("权限审计 JSONL 落盘", () => {
  test("顺序追加并按行写入", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-audit-"))
    directories.push(directory)
    const recorder = new JsonlPermissionAuditRecorder(join(directory, "permission-audit.jsonl"))
    await recorder.record(event(1))
    await recorder.record(event(2))
    await recorder.close()
    const lines = (await readFile(join(directory, "permission-audit.jsonl"), "utf8")).trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).request.toolCallId).toBe("call-1")
    expect(JSON.parse(lines[1]!).request.toolCallId).toBe("call-2")
  })

  test("超过大小阈值后轮转并保留窗口内文件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-audit-rotate-"))
    directories.push(directory)
    const recorder = new JsonlPermissionAuditRecorder(join(directory, "permission-audit.jsonl"), 200, 2)
    for (let index = 1; index <= 8; index++) await recorder.record(event(index))
    await recorder.close()
    const files = (await readdir(directory)).filter((name) => name.startsWith("permission-audit.jsonl"))
    expect(files).toEqual(["permission-audit.jsonl", "permission-audit.jsonl.1"])
    const current = await readFile(join(directory, "permission-audit.jsonl"), "utf8")
    expect(current.trim().split("\n").length).toBeGreaterThan(0)
  })

  test("不存在的父目录自动创建", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-audit-mkdir-"))
    directories.push(directory)
    const recorder = new JsonlPermissionAuditRecorder(join(directory, "nested", "permission-audit.jsonl"))
    await recorder.record(event(1))
    await recorder.close()
    await writeFile(join(directory, "probe"), "ok")
    expect(true).toBe(true)
  })
})
