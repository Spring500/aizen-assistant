import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { join } from "node:path"
import { developmentArguments } from "../../scripts/dev/run-tui.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

test("开发命令默认使用 worktree 内的本地数据目录", () => {
  const root = "E:\\project\\worktree"
  expect(developmentArguments([], root)).toEqual(["--data-dir", join(root, ".aizen", "dev-data")])
})

test("开发命令保留显式启动参数", () => {
  expect(developmentArguments(["--data-dir", "test-data"], "E:\\project\\worktree")).toEqual([
    "--data-dir",
    "test-data",
  ])
})

test("开发命令只指定收集开关时仍补充默认数据目录", () => {
  const root = "E:\\project\\worktree"
  expect(developmentArguments(["--collect-permission-gaps"], root)).toEqual([
    "--data-dir",
    join(root, ".aizen", "dev-data"),
    "--collect-permission-gaps",
  ])
})
