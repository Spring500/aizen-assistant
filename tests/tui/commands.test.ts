import { expect, test } from "bun:test"
import { parseTuiCommand } from "../../apps/tui/commands.ts"

test("重命名命令支持行内名称和无参数编辑", () => {
  expect(parseTuiCommand("/rename 新名称")).toEqual({ name: "/rename", argument: "新名称" })
  expect(parseTuiCommand("/rename")).toEqual({ name: "/rename" })
  expect(parseTuiCommand("/compact 保留当前目标")).toEqual({ name: "/compact", argument: "保留当前目标" })
  expect(parseTuiCommand("/compact")).toEqual({ name: "/compact" })
  expect(parseTuiCommand("/rewind")).toEqual({ name: "/rewind" })
  expect(parseTuiCommand("/agents")).toEqual({ name: "/agents" })
  expect(parseTuiCommand("/unknown")).toBeUndefined()
})
