import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFileValidator } from "../../../packages/core/tool-permissions/validators/file.ts"
import type { ToolPermissionRequest } from "../../../packages/core/tool-permissions/types.ts"

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

test("edit 匹配失败转人工并说明失败替换块", async () => {
  const root = await setup()
  await writeFile(join(root, "source.ts"), "const value = 1\n")
  const result = await createFileValidator("edit").validate(
    request(root, "edit", {
      path: "source.ts",
      edits: [{ oldText: "const missing = 1", newText: "const value = 2" }],
    }),
  )
  expect(result.type).toBe("needHumanReview")
  expect(result.assessment.reason).toContain("没有匹配")
  expect(result.assessment.findings).toMatchObject([{ category: "edit-preview" }])
})

test("依赖清单交给AI审核", async () => {
  const root = await setup()
  expect(
    (await createFileValidator("write").validate(request(root, "write", { path: "package.json", content: "{}" }))).type,
  ).toBe("needAiReview")
})

test("工作区外和敏感路径交给人工", async () => {
  const root = await setup()
  const outside = await mkdtemp(join(tmpdir(), "aizen-outside-"))
  directories.push(outside)
  await writeFile(join(outside, "secret.txt"), "secret")
  expect(
    (await createFileValidator("read").validate(request(root, "read", { path: join(outside, "secret.txt") }))).type,
  ).toBe("needHumanReview")
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
