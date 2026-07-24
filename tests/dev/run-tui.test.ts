import { expect, test } from "bun:test"
import { join } from "node:path"
import { developmentArguments } from "../../scripts/dev/run-tui.ts"

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
