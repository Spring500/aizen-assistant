import { describe, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { dataDirectoryFromExecutable, projectDirectoryName, resolveDataDirectory } from "../../packages/core/paths.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

describe("数据路径", () => {
  test("生产数据目录位于 exe 同目录", () => {
    expect(dataDirectoryFromExecutable("C:\\Apps\\AizenAssistant\\aizen-assistant.exe")).toBe(
      "C:\\Apps\\AizenAssistant\\data",
    )
  })

  test("Windows 路径大小写和分隔符不影响项目目录", () => {
    const first = projectDirectoryName("E:\\Project\\AizenAssistant")
    const second = projectDirectoryName("e:/project/aizenassistant/")
    expect(first).toBe(second)
    expect(first).toMatch(/^aizenassistant-[0-9a-f]{12}$/)
  })

  test("源码模式必须指定独立数据目录", () => {
    expect(() => resolveDataDirectory(undefined, "C:\\Bun\\bun.exe", "E:\\Project", true)).toThrow(
      "必须传入 --data-dir",
    )
    expect(resolveDataDirectory(".aizen/dev-data", "C:\\Bun\\bun.exe", "E:\\Project", true)).toBe(
      "E:\\Project\\.aizen\\dev-data",
    )
    expect(() => resolveDataDirectory(".", "C:\\Bun\\bun.exe", "E:\\Project", true)).toThrow(
      "数据目录不能是当前工作目录",
    )
  })
})
