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
    for (const index of [0, 1, 2]) {
      const block = view.scrollBox.getRenderable(`transcript-entry-${index}`)
      expect(block).toBeInstanceOf(BoxRenderable)
      expect(block?.width).toBe(view.scrollBox.content.width)
    }
  } finally {
    setup.renderer.destroy()
  }
})
