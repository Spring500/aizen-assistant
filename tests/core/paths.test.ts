import { describe, expect, test } from "bun:test"
import { dataDirectoryFromExecutable, projectDirectoryName } from "../../packages/core/paths.ts"

describe("数据路径", () => {
  test("生产数据目录位于 exe 同目录", () => {
    expect(dataDirectoryFromExecutable("C:\\Apps\\AizenAssistant\\aizen-tui.exe")).toBe(
      "C:\\Apps\\AizenAssistant\\data",
    )
  })

  test("Windows 路径大小写和分隔符不影响项目目录", () => {
    const first = projectDirectoryName("E:\\Project\\AizenAssistant")
    const second = projectDirectoryName("e:/project/aizenassistant/")
    expect(first).toBe(second)
    expect(first).toMatch(/^aizenassistant-[0-9a-f]{12}$/)
  })
})
