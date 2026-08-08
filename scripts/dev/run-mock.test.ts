import { afterEach, expect } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDiagnosticTest } from "../../tests/utils/diagnostic-test.ts"
import { availableMockSuites, parseMockArguments, prepareMockData } from "./run-mock.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("解析套件名与保留运行数据参数", () => {
  expect(parseMockArguments([])).toEqual({ suite: "default", keep: false })
  expect(parseMockArguments(["review", "--keep"])).toEqual({ suite: "review", keep: true })
  expect(() => parseMockArguments(["one", "two"])).toThrow("只能指定一个套件名")
})

test("重建或保留 mock-data 运行实例", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-mock-launcher-"))
  directories.push(root)
  const templates = join(root, "templates")
  const source = join(templates, "default")
  await Bun.write(join(source, "config.json"), '{"version": 1}\n')
  expect(await availableMockSuites(templates)).toEqual(["default"])
  const data = await prepareMockData({ root, templatesDirectory: templates, suite: "default", keep: false })
  expect(await readFile(join(data, "config.json"), "utf8")).toContain('"version": 1')
  await writeFile(join(data, "config.json"), '{"changed": true}\n')
  await prepareMockData({ root, templatesDirectory: templates, suite: "default", keep: true })
  expect(await readFile(join(data, "config.json"), "utf8")).toContain('"changed": true')
  await prepareMockData({ root, templatesDirectory: templates, suite: "default", keep: false })
  expect(await readFile(join(data, "config.json"), "utf8")).toContain('"version": 1')
})

test("未知套件列出可用名称", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-mock-launcher-"))
  directories.push(root)
  const templates = join(root, "templates")
  await Bun.write(join(templates, "default", ".keep"), "")
  await expect(prepareMockData({ root, templatesDirectory: templates, suite: "missing", keep: false })).rejects.toThrow(
    "自举套件不存在：missing；可用套件：default",
  )
})
