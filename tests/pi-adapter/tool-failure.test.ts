import { expect, test } from "bun:test"
import { normalizeToolFailure } from "../../packages/pi-adapter/tool-failure.ts"

test("Bash 中止保留部分输出并追加统一状态", () => {
  expect(normalizeToolFailure("bash", new Error("line one\nline two\n\nCommand aborted"))).toEqual({
    kind: "aborted",
    message: "line one\nline two\n\nOperation aborted: User aborted the turn while the tool was running.",
  })
})

test("Bash 超时和退出码保留输出并使用统一状态", () => {
  expect(normalizeToolFailure("bash", new Error("partial\n\nCommand timed out after 5 seconds"))).toEqual({
    kind: "timedOut",
    message: "partial\n\nOperation timed out: Command timed out after 5 seconds.",
  })
  expect(normalizeToolFailure("bash", new Error("build output\n\nCommand exited with code 2"))).toEqual({
    kind: "failed",
    message: "build output\n\nOperation failed: Command exited with code 2.",
  })
})

test("普通工具异常统一转换为 Operation failed", () => {
  expect(normalizeToolFailure("edit", new Error("write failed"))).toEqual({
    kind: "failed",
    message: "Operation failed: write failed",
  })
})
