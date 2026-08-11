import { afterEach, describe, expect } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBuiltinFileClassifier } from "../../../packages/core/tool-permissions/classifiers/file.ts"
import { createDiagnosticTest } from "../../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "aizen-file-classifier-"))
  roots.push(home)
  const workspace = join(home, "project")
  await mkdir(join(workspace, "src"), { recursive: true })
  await writeFile(join(workspace, "src", "a.ts"), "export {}")
  await writeFile(join(workspace, ".env"), "TOKEN=test")
  return {
    home,
    workspace,
    context: {
      workspaceRoot: workspace,
      homeDirectory: home,
      sensitivePaths: [
        ".env",
        ".npmrc",
        ".pypirc",
        "credentials",
        "credentials.json",
        "id_rsa",
        "id_ed25519",
        ".ssh",
        ".git",
        ".aizen",
        "auth.json",
      ],
      shell: "bash",
      platform: process.platform,
    },
  }
}

function tags(result: Awaited<ReturnType<ReturnType<typeof createBuiltinFileClassifier>["classify"]>>) {
  return result.kind === "claims" ? result.claims.map((claim) => claim.tag) : []
}

describe("内置文件工具分类器", () => {
  test("读取工作区文件同时声称 workspace 和 home", async () => {
    const { workspace, context } = await fixture()
    const classifier = createBuiltinFileClassifier()
    const result = await classifier.classify(
      { toolName: "read", arguments: { path: "src/a.ts" }, cwd: workspace },
      context,
    )
    expect(tags(result)).toEqual(["read-workspace", "read-home"])
  })

  test("grep、find、ls 默认读取 cwd 并覆盖显式路径", async () => {
    const { workspace, context } = await fixture()
    const classifier = createBuiltinFileClassifier()
    for (const toolName of ["grep", "find", "ls"])
      expect(tags(await classifier.classify({ toolName, arguments: {}, cwd: workspace }, context))).toEqual([
        "read-workspace",
        "read-home",
      ])
    expect(
      tags(await classifier.classify({ toolName: "find", arguments: { path: "src" }, cwd: workspace }, context)),
    ).toEqual(["read-workspace", "read-home"])
  })

  test("敏感文件叠加 sensitive 标签", async () => {
    const { workspace, context } = await fixture()
    const result = await createBuiltinFileClassifier().classify(
      { toolName: "read", arguments: { path: ".env" }, cwd: workspace },
      context,
    )
    expect(tags(result)).toEqual(["read-workspace", "read-home", "read-sensitive"])
  })

  test("写入权限系统配置声称 violation", async () => {
    const { workspace, context } = await fixture()
    const result = await createBuiltinFileClassifier().classify(
      { toolName: "write", arguments: { path: ".aizen/policy.json", content: "{}" }, cwd: workspace },
      context,
    )
    expect(tags(result)).toEqual(["edit-workspace", "edit-home", "edit-sensitive", "violation"])
  })

  test("私钥与证书扩展名路径声称敏感", async () => {
    const { workspace, context } = await fixture()
    const result = await createBuiltinFileClassifier().classify(
      { toolName: "write", arguments: { path: "keys/backup.pem" }, cwd: workspace },
      context,
    )
    expect(tags(result)).toContain("edit-sensitive")
  })

  test("credentials.json 与 .ssh 路径声称敏感", async () => {
    const { home, context } = await fixture()
    const classifier = createBuiltinFileClassifier()
    const credential = await classifier.classify(
      { toolName: "read", arguments: { path: join(home, ".ssh", "credentials.json") }, cwd: home },
      context,
    )
    expect(tags(credential)).toEqual(["read-home", "read-sensitive"])
  })

  test("工作区和用户目录之外的路径声称 system", async () => {
    const { workspace, context } = await fixture()
    const outside = join(tmpdir(), `aizen-outside-${crypto.randomUUID()}`)
    roots.push(outside)
    const result = await createBuiltinFileClassifier().classify(
      { toolName: "read", arguments: { path: outside }, cwd: workspace },
      context,
    )
    expect(tags(result)).toEqual(["read-system"])
  })

  test("参数无效时弃权", async () => {
    const { workspace, context } = await fixture()
    expect(
      await createBuiltinFileClassifier().classify(
        { toolName: "read", arguments: { path: 1 }, cwd: workspace },
        context,
      ),
    ).toEqual({ kind: "abstain" })
  })
})
