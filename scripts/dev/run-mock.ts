import { cp, readdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { main as runTui } from "../../apps/tui/main.ts"
import { startMockServer } from "../../tests/utils/mock-server.ts"

const mockPort = 39527

type MockLaunchOptions = { suite: string; keep: boolean }

/** 解析自举套件启动参数。 */
export function parseMockArguments(args: string[]): MockLaunchOptions {
  let suite = "default"
  let keep = false
  for (const argument of args) {
    if (argument === "--keep") {
      if (keep) throw new Error("--keep 不能重复指定")
      keep = true
    } else if (argument.startsWith("--")) throw new Error(`未知的自举套件参数：${argument}`)
    else if (suite === "default") suite = argument
    else throw new Error("只能指定一个套件名")
  }
  return { suite, keep }
}

/** 列出仓库中可用的自举套件模板名称。 */
export async function availableMockSuites(templatesDirectory: string): Promise<string[]> {
  try {
    const entries = await readdir(templatesDirectory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

/** 重建运行数据目录，或在 --keep 时保留现有实例。 */
export async function prepareMockData(input: {
  root: string
  templatesDirectory: string
  suite: string
  keep: boolean
}): Promise<string> {
  const source = join(input.templatesDirectory, input.suite)
  const suites = await availableMockSuites(input.templatesDirectory)
  if (!suites.includes(input.suite))
    throw new Error(`自举套件不存在：${input.suite}；可用套件：${suites.join("、") || "无"}`)
  const destination = join(input.root, "mock-data")
  if (input.keep) return destination
  await rm(destination, { recursive: true, force: true })
  await cp(source, destination, { recursive: true })
  return destination
}

/** 启动固定端口的 Mock Server 和使用自举数据目录的交互式 TUI。 */
export async function runMockDevelopment(args: string[] = process.argv.slice(2)): Promise<number> {
  const root = resolve(import.meta.dir, "..", "..")
  process.chdir(root)
  let options: MockLaunchOptions
  try {
    options = parseMockArguments(args)
    const dataDirectory = await prepareMockData({
      root,
      templatesDirectory: join(root, "tests", "fixtures", "mock-data-templates"),
      ...options,
    })
    const mock = await startMockServer({ port: mockPort })
    try {
      return await runTui(["--data-dir", dataDirectory])
    } finally {
      mock.stop()
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) process.exitCode = await runMockDevelopment()
