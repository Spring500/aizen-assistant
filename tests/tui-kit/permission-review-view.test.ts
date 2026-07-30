import { afterEach, expect, test } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { HumanReviewRequest } from "../../packages/core/tool-permissions/types.ts"
import { OverlayManager } from "../../packages/tui-kit/overlay-manager.ts"
import { createPermissionReviewView } from "../../packages/tui-kit/permission-review-view.ts"

const renderers: Array<Awaited<ReturnType<typeof createTestRenderer>>> = []
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.renderer.destroy()
})

function key(value: string): KeyEvent {
  const parsed = parseKeypress(value)
  if (!parsed) throw new Error("按键无效")
  return new KeyEvent(parsed)
}

function request(id: string, toolName: string): HumanReviewRequest {
  return {
    requestId: id,
    sessionId: "session",
    turnId: "turn",
    toolCallId: id,
    toolName,
    declaredIntent: "验证审批界面",
    cwd: process.cwd(),
    arguments: toolName === "bash" ? { command: "npm install" } : { path: "file.ts", content: "x" },
    assessment: {
      summary: "执行测试动作",
      targets: ["file.ts"],
      risk: "medium",
      reason: "需要确认",
      details: toolName === "bash" ? { command: "npm install" } : { content: "完整正文" },
    },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  }
}

test("审批页展示队列并提交批准或拒绝", async () => {
  const setup = await createTestRenderer({ width: 100, height: 28 })
  renderers.push(setup)
  const overlays = new OverlayManager(setup.renderer)
  const answers: Array<{ id: string; decision: string }> = []
  const controller = createPermissionReviewView(
    overlays,
    [request("one", "bash"), request("two", "write")],
    (id, decision) => answers.push({ id, decision }),
  )
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("请求 1/2 · bash")
  setup.renderer.keyInput.emit("keypress", key("\x1b[C"))
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("请求 2/2 · write")
  setup.renderer.keyInput.emit("keypress", key("d"))
  expect(answers).toEqual([{ id: "two", decision: "deny" }])
  controller.close()
})
