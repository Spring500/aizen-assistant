import { describe, expect, test } from "bun:test"
import type { MessageRecord, TurnStartedRecord } from "../../packages/core/session-format.ts"
import { coreMessageToPi, piMessageToCore, turnInputToPi } from "../../packages/pi-adapter/message-mapper.ts"

describe("pi 消息转换", () => {
  test("转换长期输入和仅当轮输入", () => {
    const turn: TurnStartedRecord = {
      kind: "turn_started",
      recordId: "r1",
      turnId: "t1",
      at: "2026-07-23T10:00:00.000Z",
      view: { viewId: "empty", contentHash: "sha256:abc" },
      items: [
        { source: "memory", role: "developer", useLater: false, parts: [{ kind: "text", text: "额外内容" }] },
        { source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "用户问题" }] },
      ],
    }

    const mapped = turnInputToPi(turn.items, 100)
    expect(mapped).toHaveLength(2)
    expect(mapped[0]?.persistent).toBe(false)
    expect(mapped[0]?.message.content).toContain("额外内容")
    expect(mapped[1]?.persistent).toBe(true)
  })

  test("助手消息往返保留思考、工具调用、签名和来源", () => {
    const message: MessageRecord["message"] = {
      role: "assistant",
      parts: [
        { kind: "text", text: "文字" },
        { kind: "thinking", text: "思考", signature: "thinking-signature" },
        {
          kind: "tool_call",
          callId: "c1",
          name: "bash",
          arguments: { command: "bun test" },
          signature: "tool-signature",
        },
      ],
      source: {
        providerId: "anthropic",
        modelId: "model",
        api: "anthropic-messages",
        responseId: "response-1",
        responseModel: "actual-model",
      },
      stopReason: "tool_use",
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1 },
    }

    expect(piMessageToCore(coreMessageToPi(message, 100))).toEqual(message)
  })

  test("工具结果往返保留错误和详情", () => {
    const message: MessageRecord["message"] = {
      role: "tool",
      callId: "c1",
      name: "bash",
      parts: [{ kind: "text", text: "失败" }],
      isError: true,
      details: { exitCode: 1 },
    }

    expect(piMessageToCore(coreMessageToPi(message, 100))).toEqual(message)
  })

  test("助手错误往返保留错误信息", () => {
    const message: MessageRecord["message"] = {
      role: "assistant",
      parts: [],
      source: { providerId: "anthropic", modelId: "model", api: "anthropic-messages" },
      stopReason: "error",
      errorMessage: "请求失败",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }

    expect(piMessageToCore(coreMessageToPi(message, 100))).toEqual(message)
  })
})
