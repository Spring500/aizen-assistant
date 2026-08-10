import { afterEach, expect } from "bun:test"
import { createDiagnosticTest } from "../../utils/diagnostic-test.ts"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolPermissionRequest } from "../../../packages/core/tool-permissions/types.ts"
import { createFileValidator } from "../../../packages/core/tool-permissions/validators/file.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "aizen-permission-"))
  directories.push(root)
  await writeFile(join(root, "source.ts"), "export {}")
  return root
}

function request(
  root: string,
  toolName: "read" | "write" | "edit",
  argumentsValue: ToolPermissionRequest["arguments"],
): ToolPermissionRequest {
  return {
    sessionId: "session",
    turnId: "turn",
    toolCallId: "call",
    toolName,
    arguments: argumentsValue,
    declaredIntent: "测试文件权限",
    cwd: root,
    mode: "hybrid",
  }
}

test("工作区内普通源码读写直接允许", async () => {
  const root = await setup()
  expect((await createFileValidator("read").validate(request(root, "read", { path: "source.ts" }))).type).toBe("allow")
  expect(
    (await createFileValidator("write").validate(request(root, "write", { path: "next.ts", content: "x" }))).type,
  ).toBe("allow")
})

test("edit 成功预演精确替换并生成 unified diff", async () => {
  const root = await setup()
  await writeFile(join(root, "source.ts"), "const oldValue = 1\nconst keep = true\n")
  const result = await createFileValidator("edit").validate(
    request(root, "edit", {
      path: "source.ts",
      edits: [{ oldText: "const oldValue = 1", newText: "const newValue = 2" }],
    }),
  )
  expect(result.type).toBe("allow")
  expect(JSON.stringify(result.assessment.details)).toContain("---")
  expect(JSON.stringify(result.assessment.details)).toContain("+const newValue = 2")
})

test("edit 匹配失败直接返回无法执行", async () => {
  const root = await setup()
  await writeFile(join(root, "source.ts"), "const value = 1\n")
  const result = await createFileValidator("edit").validate(
    request(root, "edit", {
      path: "source.ts",
      edits: [{ oldText: "const missing = 1", newText: "const value = 2" }],
    }),
  )
  expect(result.type).toBe("deny")
  expect(result.assessment.reason).toContain("没有匹配")
  expect(result.assessment.details).toMatchObject({ previewError: expect.any(String) })
})

test("依赖清单交给AI审核并说明执行影响", async () => {
  const root = await setup()
  const result = await createFileValidator("write").validate(
    request(root, "write", { path: "package.json", content: "{}" }),
  )
  expect(result.type).toBe("needAiReview")
  expect(result.assessment.reason).toContain("执行或发布")
  expect(result.assessment.coverageGaps).toMatchObject([{ code: "file.execution-impact-coarse-rule" }])
})

test("未知文件扩展名标记分类缺口", async () => {
  const root = await setup()
  const result = await createFileValidator("write").validate(
    request(root, "write", { path: "archive.custom", content: "data" }),
  )
  expect(result.type).toBe("needAiReview")
  expect(result.assessment.coverageGaps).toMatchObject([{ code: "file.extension-unclassified" }])
})

test("工作区外和敏感路径交给人工", async () => {
  const root = await setup()
  const outside = await mkdtemp(join(tmpdir(), "aizen-outside-"))
  directories.push(outside)
  await writeFile(join(outside, "secret.txt"), "secret")
  const outsideResult = await createFileValidator("read").validate(
    request(root, "read", { path: join(outside, "secret.txt") }),
  )
  expect(outsideResult.type).toBe("needHumanReview")
  expect(outsideResult.assessment.reason).toContain("工作区外")
  await mkdir(join(root, ".git"))
  await writeFile(join(root, ".git", "config"), "x")
  expect((await createFileValidator("read").validate(request(root, "read", { path: ".git/config" }))).type).toBe(
    "needHumanReview",
  )
})

test("越界目录链接交给人工", async () => {
  const root = await setup()
  const outside = await mkdtemp(join(tmpdir(), "aizen-link-"))
  directories.push(outside)
  await writeFile(join(outside, "target.txt"), "secret")
  await symlink(outside, join(root, "link"), "junction")
  expect((await createFileValidator("read").validate(request(root, "read", { path: "link/target.txt" }))).type).toBe(
    "needHumanReview",
  )
})
