import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { CoreSnapshot } from "../../packages/core/types.ts"
import { createChatView } from "../../packages/tui-kit/chat-view.ts"

test("聊天视图显示标题、消息、工具状态和错误", async () => {
  const setup = await createTestRenderer({ width: 80, height: 20 })
  try {
    const view = createChatView(setup.renderer)
    const snapshot: CoreSnapshot = {
      cwd: "E:\\project",
      status: "running",
      sessions: [],
      currentModel: { providerId: "test", modelId: "model", api: "a", thinkingLevel: "off" },
      models: [],
      authProviders: [],
      transcript: [
        {
          type: "input",
          turnId: "t1",
          items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "你好" }] }],
        },
      ],
      activeTools: [{ callId: "c1", name: "bash", arguments: { command: "bun test" } }],
      streamingText: "",
      streamingThinking: "",
      lastError: "测试错误",
    }
    view.update(snapshot)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("AizenAssistant")
    expect(frame).toContain("[你] 你好")
    expect(frame).toContain("错误：测试错误")
  } finally {
    setup.renderer.destroy()
  }
})

test("聊天视图明确显示认证等待状态", async () => {
  const setup = await createTestRenderer({ width: 60, height: 10 })
  try {
    const view = createChatView(setup.renderer)
    view.update({
      cwd: "E:\\project",
      status: "authenticating",
      sessions: [],
      models: [],
      authProviders: [],
      transcript: [],
      activeTools: [],
      streamingText: "",
      streamingThinking: "",
    })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("等待输入认证信息")
  } finally {
    setup.renderer.destroy()
  }
})

test("聊天视图只显示工具结果的最后一行并提示省略", async () => {
  const setup = await createTestRenderer({ width: 80, height: 10 })
  try {
    const view = createChatView(setup.renderer)
    view.update({
      cwd: "E:\\project",
      status: "idle",
      sessions: [],
      models: [],
      authProviders: [],
      transcript: [
        {
          type: "message",
          turnId: "t1",
          message: {
            role: "tool",
            callId: "c1",
            name: "bash",
            parts: [{ kind: "text", text: "第一行\n最后一行\n" }],
            isError: false,
          },
        },
      ],
      activeTools: [],
      streamingText: "",
      streamingThinking: "",
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("[工具结果:bash] ...最后一行")
    expect(frame).not.toContain("第一行")
  } finally {
    setup.renderer.destroy()
  }
})

test("聊天视图显示工具参数、流式结果和整行底色容器", async () => {
  const setup = await createTestRenderer({ width: 80, height: 12 })
  try {
    const view = createChatView(setup.renderer)
    view.update({
      cwd: "E:\\project",
      status: "running",
      sessions: [],
      models: [],
      authProviders: [],
      transcript: [
        {
          type: "input",
          turnId: "t1",
          items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "运行测试" }] }],
        },
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
                arguments: { command: "bun test\n--watch" },
              },
            ],
            source: { providerId: "test", modelId: "model", api: "a" },
            stopReason: "tool_use",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
      activeTools: [
        {
          callId: "c1",
          name: "bash",
          arguments: { command: "bun test\n--watch" },
          outputPreview: "第一行\n最后一行",
        },
      ],
      streamingText: "",
      streamingThinking: "",
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("[bash] bun test ↵ --watch")
    expect(frame).toContain("[运行中] ...最后一行")
    for (const index of [0, 1]) {
      const block = view.scrollBox.getRenderable(`transcript-entry-${index}`)
      expect(block).toBeInstanceOf(BoxRenderable)
      expect(block?.width).toBe(view.scrollBox.content.width)
    }
  } finally {
    setup.renderer.destroy()
  }
})

test("聊天视图按调用标识合并工具与结果，并默认折叠连续工具", async () => {
  const setup = await createTestRenderer({ width: 100, height: 20 })
  try {
    const view = createChatView(setup.renderer)
    view.update({
      cwd: "E:\\project",
      status: "idle",
      sessions: [],
      models: [],
      authProviders: [],
      transcript: [
        {
          type: "message",
          turnId: "t1",
          message: {
            role: "assistant",
            parts: [
              { kind: "tool_call", callId: "c1", name: "bash", arguments: { command: "bun test" } },
              { kind: "tool_call", callId: "c2", name: "read", arguments: { path: "README.md" } },
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
            parts: [{ kind: "text", text: "项目说明" }],
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
            parts: [{ kind: "text", text: "测试开始\n测试通过" }],
            isError: false,
          },
        },
      ],
      activeTools: [],
      streamingText: "",
      streamingThinking: "",
    })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("▶ 2 个工具调用：bash、read（点击展开）")
    expect(setup.captureCharFrame()).not.toContain("测试通过")

    const group = view.scrollBox.getRenderable("transcript-entry-0")
    expect(group).toBeInstanceOf(BoxRenderable)
    if (!(group instanceof BoxRenderable)) throw new Error("没有创建工具分组")
    await setup.mockMouse.click(group.screenX + 1, group.screenY)
    await setup.renderOnce()
    const expanded = setup.captureCharFrame()
    expect(expanded).toContain("[bash] bun test")
    expect(expanded).toContain("[工具结果:bash] ...测试通过")
    expect(expanded).toContain("[read] README.md")
    expect(expanded).toContain("[工具结果:read] 项目说明")
  } finally {
    setup.renderer.destroy()
  }
})

test("聊天视图将助手文本放入可点击折叠的整行容器", async () => {
  const setup = await createTestRenderer({ width: 80, height: 12 })
  try {
    const view = createChatView(setup.renderer)
    view.update({
      cwd: "E:\\project",
      status: "idle",
      sessions: [],
      models: [],
      authProviders: [],
      transcript: [
        {
          type: "message",
          turnId: "t1",
          message: {
            role: "assistant",
            parts: [{ kind: "text", text: "第一行回复\n第二行回复" }],
            source: { providerId: "test", modelId: "model", api: "a" },
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
      activeTools: [],
      streamingText: "",
      streamingThinking: "",
    })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("▼ 助手（点击折叠）")
    expect(setup.captureCharFrame()).toContain("第二行回复")

    const assistant = view.scrollBox.getRenderable("transcript-entry-0")
    expect(assistant).toBeInstanceOf(BoxRenderable)
    if (!(assistant instanceof BoxRenderable)) throw new Error("没有创建助手回复容器")
    await setup.mockMouse.click(assistant.screenX + 1, assistant.screenY)
    await setup.renderOnce()
    const collapsed = setup.captureCharFrame()
    expect(collapsed).toContain("▶ 助手（点击展开） 第一行回复 ↵ 第二行回复...")
    expect(collapsed.match(/第二行回复/g)?.length).toBe(1)
  } finally {
    setup.renderer.destroy()
  }
})
