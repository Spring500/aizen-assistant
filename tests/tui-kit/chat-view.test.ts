import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { defaultAppPreferences } from "../../packages/core/app-preferences-store.ts"
import type { CoreSnapshot } from "../../packages/core/types.ts"
import { createChatView } from "../../packages/tui-kit/chat-view.ts"
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
  expect(statusBarView(current)).toEqual({
    session: "模型：test/model | 视图：未选择视图 | 上下文：250/1,000",
    shortcuts: "Esc 中止 | Ctrl+C 退出",
  })
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
    expect(output).toContain("[思考] 内部分析内容")
    const lines = output.split(/\r?\n/)
    const contentIndex = lines.findIndex((line) => line.includes("[思考] 内部分析内容"))
    expect(contentIndex).toBeGreaterThan(0)
    expect(lines[contentIndex - 1]?.trim()).toBe("")
    expect(lines[contentIndex + 1]?.trim()).toBe("")
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
        activeTools: [{ callId: "c1", name: "bash", arguments: { command: "bun test" } }],
      }),
    )
    await setup.renderOnce()
    const footer = setup.captureCharFrame()
    expect(footer).toContain("[bash] bun test")
    expect(footer).toContain("耗时 9s")
  } finally {
    setup.renderer.destroy()
  }
})

test("连续工具默认折叠，并可通过折叠项触发全量回放", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    view.update(
      snapshot({
        transcript: [
          {
            type: "message",
            turnId: "t1",
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "tool_call",
                  callId: "c1",
                  name: "bash",
                  arguments: { command: "bun test" },
                },
                {
                  kind: "tool_call",
                  callId: "c2",
                  name: "read",
                  arguments: { path: "README.md" },
                },
              ],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "tool_use",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
          {
            type: "message",
            turnId: "t1",
            message: {
              role: "tool",
              callId: "c2",
              name: "read",
              parts: [{ kind: "text", text: "read result" }],
              isError: false,
            },
          },
          {
            type: "message",
            turnId: "t1",
            message: {
              role: "tool",
              callId: "c1",
              name: "bash",
              parts: [{ kind: "text", text: "first line\ntest passed" }],
              isError: false,
            },
          },
        ],
      }),
    )
    await setup.renderOnce()
    const collapsed = setup.externalOutput.takeText().replace(/\s+/g, "")
    expect(collapsed).toContain("bash")
    expect(collapsed).toContain("read")
    expect(collapsed).not.toContain("test passed")

    const item = view.getCollapseItems()[0]
    expect(item).toMatchObject({
      kind: "tool_group",
      name: "工具：bash、read",
      collapsed: true,
    })
    expect(view.toggleCollapse(item?.id ?? "")).toBeTrue()
    await setup.renderOnce()
    const expanded = setup.externalOutput.takeText().replace(/\s+/g, "")
    expect(expanded).toContain("[bash]buntest")
    expect(expanded).toContain("...testpassed")
    expect(expanded).toContain("[read]README.md")
    expect(expanded).toContain("readresult")
  } finally {
    setup.renderer.destroy()
  }
})

test("助手回复可通过折叠项切换并全量回放", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    view.update(
      snapshot({
        transcript: [
          {
            type: "message",
            turnId: "t1",
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "text",
                  text: "first response line\nsecond response line",
                },
              ],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "stop",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
        ],
      }),
    )
    await setup.renderOnce()
    expect(setup.externalOutput.takeText().replace(/\s+/g, "")).toContain("secondresponseline")

    const item = view.getCollapseItems()[0]
    expect(item).toMatchObject({
      kind: "assistant",
      name: "助手",
      collapsed: false,
    })
    expect(view.toggleCollapse(item?.id ?? "")).toBeTrue()
    await setup.renderOnce()
    const collapsed = setup.externalOutput.takeText().replace(/\s+/g, "")
    expect(collapsed).toContain("firstresponseline")
    expect(collapsed).toContain("...")
    expect(collapsed.match(/secondresponseline/g)?.length ?? 0).toBe(1)
  } finally {
    setup.renderer.destroy()
  }
})

test("可批量折叠工具组并展开全部内容", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    view.update(
      snapshot({
        transcript: [
          {
            type: "message",
            turnId: "t1",
            message: {
              role: "assistant",
              parts: [
                { kind: "text", text: "assistant response" },
                {
                  kind: "tool_call",
                  callId: "c1",
                  name: "bash",
                  arguments: { command: "bun test" },
                },
                {
                  kind: "tool_call",
                  callId: "c2",
                  name: "read",
                  arguments: { path: "README.md" },
                },
              ],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "tool_use",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
        ],
      }),
    )
    await setup.renderOnce()
    setup.externalOutput.take()

    expect(view.collapseAll(true, "tool_group")).toBeFalse()
    expect(view.collapseAll(true, "assistant")).toBeTrue()
    expect(view.getCollapseItems().every((item) => item.collapsed)).toBeTrue()
    expect(view.collapseAll(false)).toBeTrue()
    expect(view.getCollapseItems().every((item) => !item.collapsed)).toBeTrue()
  } finally {
    setup.renderer.destroy()
  }
})

test("历史没有变化时不重复写入 scrollback", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    const current = snapshot({
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
    })
    view.update(current)
    await setup.renderOnce()
    expect(setup.externalOutput.take()).toHaveLength(1)

    view.update({ ...current, status: "running", streamingText: "working" })
    await setup.renderOnce()
    expect(setup.externalOutput.take()).toHaveLength(0)
    expect(setup.captureCharFrame()).toContain("working")
  } finally {
    setup.renderer.destroy()
  }
})
