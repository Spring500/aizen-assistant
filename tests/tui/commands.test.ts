import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { parseTuiCommand } from "../../apps/tui/commands.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

test("重命名命令支持行内名称和无参数编辑", () => {
  expect(parseTuiCommand("/rename 新名称")).toEqual({ name: "/rename", argument: "新名称" })
  expect(parseTuiCommand("/rename")).toEqual({ name: "/rename" })
  expect(parseTuiCommand("/compact 保留当前目标")).toEqual({ name: "/compact", argument: "保留当前目标" })
  expect(parseTuiCommand("/compact")).toEqual({ name: "/compact" })
  expect(parseTuiCommand("/rewind")).toEqual({ name: "/rewind" })
  expect(parseTuiCommand("/session-settings")).toEqual({ name: "/session-settings" })
  expect(parseTuiCommand("/preferences")).toEqual({ name: "/preferences" })
  expect(parseTuiCommand("/skills")).toEqual({ name: "/skills" })
  expect(parseTuiCommand("/toggle-think")).toEqual({ name: "/toggle-think" })
  expect(parseTuiCommand("/toggle-tool")).toEqual({ name: "/toggle-tool" })
  expect(parseTuiCommand("/context")).toEqual({ name: "/context" })
  expect(parseTuiCommand("/unknown")).toBeUndefined()
})
