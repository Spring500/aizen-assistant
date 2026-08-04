import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { defaultAppPreferences } from "../../packages/core/app-preferences-store.ts"
import type { CoreSnapshot } from "../../packages/core/types.ts"
import { createChatView, formatDurationText } from "../../packages/tui-kit/chat-view.ts"
import { statusBarView } from "../../packages/tui-kit/status-bar.ts"

function snapshot(overrides: Partial<CoreSnapshot> = {}): CoreSnapshot {
  return {
    cwd: "E:\\project",
    status: "idle",
    sessions: [],
    models: [],
    preferences: structuredClone(defaultAppPreferences),
    views: [],
    authProviders: [],
    transcript: [],
    activeTools: [],
    streamingText: "",
    streamingThinking: "",
    ...overrides,
  }
}

async function setupRepl(width = 100, height = 20) {
  return createTestRenderer({
    width,
    height,
    screenMode: "split-footer",
    footerHeight: 9,
    externalOutputMode: "capture-stdout",
  })
}

test("状态栏视图模型根据运行状态生成统一内容", () => {
  const current = snapshot({
    status: "running",
    currentSessionId: "s1",
    currentModel: { providerId: "test", modelId: "model", api: "a", thinkingLevel: "off", contextWindow: 1000 },
    contextUsage: { used: 250, total: 1000 },
  })
  const view = statusBarView(current)
  expect(
    typeof view.session === "string" ? view.session : view.session.chunks.map((chunk) => chunk.text).join(""),
  ).toContain("权限：自动+人工")
  expect(view.shortcuts).toBe("Esc 中止 | Ctrl+C 退出")
})

test("聊天视图把历史写入原生 scrollback，并在 footer 显示状态", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    view.update(
      snapshot({
        status: "running",
        currentModel: {
          providerId: "test",
          modelId: "model",
          api: "a",
          thinkingLevel: "off",
        },
        transcript: [
          {
            type: "input",
            turnId: "t1",
            items: [
              {
                source: "user",
                role: "user",
                useLater: true,
                parts: [{ kind: "text", text: "hello" }],
              },
            ],
          },
        ],
        activeTools: [{ callId: "c1", name: "bash", arguments: { command: "bun test" } }],
      }),
    )
    await setup.renderOnce()
    const history = setup.externalOutput.takeText().replace(/\s+/g, "")
    const footer = setup.captureCharFrame()
    expect(history).toContain("hello")
    expect(footer).toContain("AizenAssistant | /fold")
    expect(footer).toContain("[bash] bun test")
  } finally {
    setup.renderer.destroy()
  }
})

test("历史块包含同底色的上下留白并记录思考内容", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    view.update(
      snapshot({
        transcript: [
          {
            type: "message",
            turnId: "thinking-turn",
            message: {
              role: "assistant",
              parts: [{ kind: "thinking", text: "内部分析内容", signature: "sig" }],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "stop",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
        ],
      }),
    )
    await setup.renderOnce()
    const output = setup.externalOutput.takeText()
    expect(output).toContain("▼ 思考")
    expect(output.replace(/\r?\n/g, "")).toContain("内部分析内容")
    view.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("resize 会按新宽度全量回放历史", async () => {
  const setup = await setupRepl(80, 20)
  try {
    const view = createChatView(setup.renderer)
    view.update(
      snapshot({
        transcript: [
          {
            type: "input",
            turnId: "resize-turn",
            items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "resize 内容" }] }],
          },
        ],
      }),
    )
    await setup.renderOnce()
    setup.externalOutput.takeText()
    setup.renderer.resize(40, 20)
    await Bun.sleep(100)
    await setup.renderOnce()
    expect(setup.externalOutput.takeText()).toContain("resize 内容")
    view.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("footer 显示回复耗时、生成 token 和上下文用量", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    view.update(
      snapshot({
        status: "running",
        responseMetrics: { startedAt: Date.now(), elapsedSeconds: 7, outputTokens: 42 },
        contextUsage: { used: 12345, total: 200000 },
        streamingText: "partial answer",
        currentModel: {
          providerId: "test",
          modelId: "model",
          api: "a",
          thinkingLevel: "off",
          contextWindow: 200000,
        },
      }),
    )
    await setup.renderOnce()
    const footer = setup.captureCharFrame()
    expect(footer).toContain("耗时 7s · 生成 42 tokens")
  } finally {
    setup.renderer.destroy()
  }
})

test("工具调用时也显示当前回复耗时", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    view.update(
      snapshot({
        status: "running",
        responseMetrics: { startedAt: Date.now(), elapsedSeconds: 9, outputTokens: 0 },
        activeTools: [
          {
            callId: "c1",
            name: "bash",
            arguments: { command: "bun test", declaredIntent: "验证测试" },
          },
        ],
      }),
    )
    await setup.renderOnce()
    const footer = setup.captureCharFrame()
    expect(footer).toContain("[bash] bun test")
    expect(footer).toContain("目的：验证测试")
    expect(footer).toContain("耗时 9s")
  } finally {
    setup.renderer.destroy()
  }
})

test("同一轮内跨助手消息的连续工具调用合并为一个工具组", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    view.update(
      snapshot({
        preferences: {
          ...structuredClone(defaultAppPreferences),
          fold: { userTurns: 0, assistantTurns: 0, thinkingTurns: 0, toolGroupTurns: 2, toolDetailTurns: 1 },
        },
        transcript: [
          {
            type: "message",
            turnId: "tools",
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "tool_call",
                  callId: "c1",
                  name: "bash",
                  arguments: { command: "bun test" },
                  declaredIntent: "运行测试",
                },
              ],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "tool_use",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
          {
            type: "message",
            turnId: "tools",
            message: {
              role: "tool",
              callId: "c1",
              name: "bash",
              parts: [{ kind: "text", text: "first" }],
              isError: false,
            },
          },
          {
            type: "message",
            turnId: "tools",
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "tool_call",
                  callId: "c2",
                  name: "bash",
                  arguments: { command: "bun run typecheck" },
                  declaredIntent: "检查类型",
                },
              ],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "tool_use",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
          {
            type: "message",
            turnId: "tools",
            message: {
              role: "tool",
              callId: "c2",
              name: "bash",
              parts: [{ kind: "text", text: "second" }],
              isError: false,
            },
          },
          {
            type: "input",
            turnId: "recent",
            items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "下一轮" }] }],
          },
        ],
      }),
    )
    await setup.renderOnce()
    const output = setup.externalOutput.takeText().replace(/\s+/g, "")
    expect(output).toContain("▼2个工具调用：bash/bash")
    expect(output.match(/个工具调用/g)).toHaveLength(1)
    expect(output).toContain("[bash]运行测试")
    expect(output).toContain("[bash]检查类型")
  } finally {
    setup.renderer.destroy()
  }
})

test("耗时格式覆盖天时分秒", () => {
  expect(formatDurationText(0)).toBe("0s")
  expect(formatDurationText(62_000)).toBe("1m 2s")
  expect(formatDurationText(93_784_000)).toBe("1d 2h 3m 4s")
})

test("历史没有变化时不重复写入 scrollback", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    const current = snapshot({
      preferences: {
        ...structuredClone(defaultAppPreferences),
        fold: { userTurns: 1, assistantTurns: 1, thinkingTurns: 1, toolGroupTurns: 1, toolDetailTurns: 1 },
      },
      transcript: [
        {
          type: "input",
          turnId: "old",
          items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "旧轮次用户消息" }] }],
        },
        {
          type: "message",
          turnId: "old",
          message: {
            role: "assistant",
            parts: [{ kind: "text", text: "旧轮次助手正文" }],
            source: { providerId: "test", modelId: "model", api: "a" },
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
        },
        {
          type: "input",
          turnId: "recent",
          items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "最近用户消息" }] }],
        },
        {
          type: "message",
          turnId: "recent",
          message: {
            role: "assistant",
            parts: [
              { kind: "thinking", text: "最近思考", timing: { startedAt: 1000, finishedAt: 3000 } },
              {
                kind: "tool_call",
                callId: "c1",
                name: "bash",
                arguments: { command: "bun test" },
                declaredIntent: "验证全部测试是否通过",
              },
            ],
            source: { providerId: "test", modelId: "model", api: "a" },
            stopReason: "tool_use",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
        },
        {
          type: "message",
          turnId: "recent",
          message: {
            role: "tool",
            callId: "c1",
            name: "bash",
            parts: [{ kind: "text", text: "all passed" }],
            isError: false,
            timing: { startedAt: 3000, finishedAt: 65000 },
          },
        },
      ],
    })
    view.update(current)
    await setup.renderOnce()
    const firstOutput = setup.externalOutput.takeText().replace(/\s+/g, "")
    expect(firstOutput).toContain("▶你旧轮次用户消息")
    expect(firstOutput).toContain("▶助手旧轮次助手正文")
    expect(firstOutput).toContain("[bash]验证全部测试是否通过")
    expect(firstOutput).toContain("›buntest")
    expect(firstOutput).toContain("✓allpassed")
    expect(firstOutput).toContain("1m2s")
    expect(firstOutput).toContain("allpassed")

    view.update({ ...current, status: "running", streamingText: "working" })
    await setup.renderOnce()
    expect(setup.externalOutput.take()).toHaveLength(0)
    expect(setup.captureCharFrame()).toContain("working")
  } finally {
    setup.renderer.destroy()
  }
})
