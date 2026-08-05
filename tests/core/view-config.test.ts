import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_VIEW_CONFIG,
  parseViewConfigValue,
  readViewConfig,
  writeViewConfig,
} from "../../packages/core/view-config.ts"

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function temporaryDirectory() {
  const root = await mkdtemp(join(tmpdir(), "aizen-config-"))
  directories.push(root)
  return root
}

describe("视图行为配置", () => {
  test("严格校验字段与枚举取值", () => {
    expect(parseViewConfigValue({ projectSources: "none", loadUserSkills: true })).toEqual({
      projectSources: "none",
      loadUserSkills: true,
    })
    expect(parseViewConfigValue({ projectSources: "cwd", loadUserSkills: true })).toEqual({
      projectSources: "cwd",
      loadUserSkills: true,
    })
    expect(() => parseViewConfigValue({ projectSources: "自定义", loadUserSkills: true })).toThrow("projectSources")
    expect(() => parseViewConfigValue({ projectSources: "none", loadUserSkills: "yes" })).toThrow("loadUserSkills")
    expect(() => parseViewConfigValue({ projectSources: "none", loadUserSkills: true, extra: true })).toThrow(
      "未知字段",
    )
  })

  test("缺失配置按默认值处理且不报错", async () => {
    const root = await temporaryDirectory()
    const result = await readViewConfig(root)
    expect(result.config).toEqual(DEFAULT_VIEW_CONFIG)
    expect(result.error).toBeUndefined()
  })

  test("合法配置可读写，非法配置按默认值处理并报告（不阻塞）", async () => {
    const root = await temporaryDirectory()
    await writeViewConfig(root, { projectSources: "git-root", loadUserSkills: false })
    expect(await readViewConfig(root)).toEqual({ config: { projectSources: "git-root", loadUserSkills: false } })

    const { writeFile } = await import("node:fs/promises")
    await writeFile(join(root, "config.json"), "{")
    const invalid = await readViewConfig(root)
    expect(invalid.config).toEqual(DEFAULT_VIEW_CONFIG)
    expect(invalid.error).toContain("配置错误")
  })
})
