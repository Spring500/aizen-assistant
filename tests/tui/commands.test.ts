import { expect, test } from "bun:test"
import { parseTuiCommand } from "../../apps/tui/commands.ts"

test("重命名命令支持行内名称和无参数编辑", () => {
  expect(parseTuiCommand("/rename 新名称")).toEqual({ name: "/rename", argument: "新名称" })
  expect(parseTuiCommand("/rename")).toEqual({ name: "/rename" })
  expect(parseTuiCommand("/rewind")).toEqual({ name: "/rewind" })
  expect(parseTuiCommand("/unknown")).toBeUndefined()
})
