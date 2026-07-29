import { describe, expect, test } from "bun:test"
import { parseSessionLine, type SessionRecord } from "../../packages/core/session-format.ts"

const header = {
  kind: "session",
  version: 1,
  sessionId: "session-1",
  cwd: "E:\\project",
  createdAt: "2026-07-23T10:00:00.000Z",
}

describe("会话格式", () => {
  test("接受文件头和七类记录", () => {
    const records: unknown[] = [
      header,
      {
        kind: "session_renamed",
        recordId: "r0",
        at: "2026-07-23T10:00:00.500Z",
        name: "需求讨论",
      },
      {
        kind: "model_changed",
        recordId: "r1",
        at: "2026-07-23T10:00:01.000Z",
        model: { providerId: "anthropic", modelId: "model", api: "anthropic-messages", thinkingLevel: "medium" },
      },
      {
        kind: "view_changed",
        recordId: "r2",
        at: "2026-07-23T10:00:01.000Z",
        viewId: null,
      },
      {
        kind: "turn_started",
        recordId: "r3",
        turnId: "t1",
        at: "2026-07-23T10:00:02.000Z",
        viewId: null,
        items: [
          { source: "memory", role: "user", useLater: false, parts: [{ kind: "text", text: "只用于本轮" }] },
          { source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "检查测试" }] },
        ],
      },
      {
        kind: "message",
        recordId: "r4",
        turnId: "t1",
        at: "2026-07-23T10:00:03.000Z",
        message: {
          role: "assistant",
          parts: [
            { kind: "thinking", text: "分析", signature: "sig", timing: { startedAt: 1000, finishedAt: 2500 } },
            {
              kind: "tool_call",
              callId: "c1",
              name: "bash",
              arguments: { command: "bun test" },
              declaredIntent: "运行测试以验证修改",
            },
          ],
          source: { providerId: "anthropic", modelId: "model", api: "anthropic-messages" },
          stopReason: "tool_use",
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        },
      },
      {
        kind: "turn_finished",
        recordId: "r5",
        turnId: "t1",
        at: "2026-07-23T10:00:04.000Z",
        outcome: "completed",
      },
      {
        kind: "compaction",
        recordId: "r6",
        at: "2026-07-23T10:00:05.000Z",
        summary: "摘要",
        firstKeptRecordId: "r3",
        tokensBefore: 100,
      },
    ]

    for (const record of records) {
      expect(parseSessionLine(JSON.stringify(record)) as unknown).toEqual(record)
    }
  })

  test("接受工具结果中的内嵌图片", () => {
    const record = {
      kind: "message",
      recordId: "r1",
      turnId: "t1",
      at: "2026-07-23T10:00:00.000Z",
      message: {
        role: "tool",
        callId: "c1",
        name: "read",
        parts: [{ kind: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
        isError: false,
        timing: { startedAt: 1000, finishedAt: 2000 },
      },
    }

    expect(parseSessionLine(JSON.stringify(record)) as unknown).toEqual(record)
  })

  test("拒绝未知版本、未知记录和缺少字段", () => {
    expect(() => parseSessionLine(JSON.stringify({ ...header, version: 2 }))).toThrow("不支持的会话版本")
    expect(() => parseSessionLine('{"kind":"unknown"}')).toThrow("未知的会话记录类型")
    expect(() =>
      parseSessionLine('{"kind":"turn_finished","turnId":"t1","at":"2026-07-23T10:00:00.000Z","outcome":"completed"}'),
    ).toThrow("recordId")
  })

  test("拒绝无效的图片 Base64", () => {
    const record = {
      kind: "message",
      recordId: "r1",
      turnId: "t1",
      at: "2026-07-23T10:00:00.000Z",
      message: {
        role: "tool",
        callId: "c1",
        name: "read",
        parts: [{ kind: "image", mimeType: "image/png", data: "不是 Base64" }],
        isError: false,
      },
    }
    expect(() => parseSessionLine(JSON.stringify(record))).toThrow("Base64")
  })

  test("拒绝超过五十个字符的工具声明目的", () => {
    const record = {
      kind: "message",
      recordId: "r1",
      turnId: "t1",
      at: "2026-07-23T10:00:00.000Z",
      message: {
        role: "assistant",
        parts: [
          {
            kind: "tool_call",
            callId: "c1",
            name: "read",
            arguments: { path: "README.md" },
            declaredIntent: "目".repeat(51),
          },
        ],
        source: { providerId: "p", modelId: "m", api: "a" },
        stopReason: "tool_use",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }
    expect(() => parseSessionLine(JSON.stringify(record))).toThrow("必须为 1 至 50 个字符")
  })

  test("拒绝无效的内容时序", () => {
    const record = {
      kind: "message",
      recordId: "r1",
      turnId: "t1",
      at: "2026-07-23T10:00:00.000Z",
      message: {
        role: "assistant",
        parts: [{ kind: "text", text: "回复", timing: { startedAt: 2000, finishedAt: 1000 } }],
        source: { providerId: "p", modelId: "m", api: "a" },
        stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }
    expect(() => parseSessionLine(JSON.stringify(record))).toThrow("finishedAt 不能早于 startedAt")
  })

  test("拒绝非 JSON 值和 pi 内部字段", () => {
    const invalidArguments = {
      kind: "message",
      recordId: "r1",
      turnId: "t1",
      at: "2026-07-23T10:00:00.000Z",
      message: {
        role: "assistant",
        parts: [{ kind: "tool_call", callId: "c1", name: "bash", arguments: { invalid: Number.NaN } }],
        source: { providerId: "p", modelId: "m", api: "a" },
        stopReason: "tool_use",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }
    expect(() => parseSessionLine(JSON.stringify(invalidArguments).replace("null", "1e999"))).toThrow("有限数字")

    const piRecord: SessionRecord & { piEntryId: string } = {
      kind: "turn_finished",
      recordId: "r1",
      turnId: "t1",
      at: "2026-07-23T10:00:00.000Z",
      outcome: "completed",
      piEntryId: "pi-1",
    }
    expect(() => parseSessionLine(JSON.stringify(piRecord))).toThrow("未知字段")
  })
})
