import { expect, test } from "bun:test"
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
      activeTools: [{ callId: "c1", name: "bash" }],
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
