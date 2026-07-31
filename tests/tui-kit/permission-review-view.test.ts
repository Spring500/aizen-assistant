import { afterEach, expect, test } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { HumanReviewRequest } from "../../packages/core/tool-permissions/types.ts"
import { OverlayManager } from "../../packages/tui-kit/overlay-manager.ts"
import {
  createPermissionReviewView,
  type PermissionReviewAnswer,
} from "../../packages/tui-kit/permission-review-view.ts"

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

async function setupReview() {
  const setup = await createTestRenderer({ width: 100, height: 28 })
  renderers.push(setup)
  const overlays = new OverlayManager(setup.renderer)
  const answers: Array<{ id: string; answer: PermissionReviewAnswer }> = []
  const controller = createPermissionReviewView(overlays, [request("one", "bash")], (id, answer) =>
    answers.push({ id, answer }),
  )
  await setup.renderOnce()
  return { setup, answers, controller }
}

test("审批页使用通过、拒绝输入和完整内容三个选项", async () => {
  const { setup, answers, controller } = await setupReview()
  let frame = setup.captureCharFrame()
  expect(frame).toContain("工具权限审核 · 请求 1/1")
  expect(frame).toContain("通过")
  expect(frame).toContain("拒绝")
  expect(frame).toContain("查看完整命令")

  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("不允许修改依赖"))
  await setup.renderOnce()
  frame = setup.captureCharFrame()
  expect(frame).toContain("拒绝  不允许修改依赖")
  expect(frame).toContain("Enter 提交")
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  expect(answers).toEqual([{ id: "one", answer: { decision: "deny", reason: "不允许修改依赖" } }])
  controller.close()
})

test("拒绝理由草稿在切换选项后保留", async () => {
  const { setup, controller } = await setupReview()
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("保留草稿"))
  setup.renderer.keyInput.emit("keypress", key("\x1b[A"))
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("拒绝  保留草稿")
  controller.close()
})

test("审批页Esc请求中止本轮", async () => {
  const { setup, answers, controller } = await setupReview()
  setup.renderer.keyInput.emit("keypress", key("\x1b"))
  await Bun.sleep(1)
  expect(answers).toEqual([{ id: "one", answer: { decision: "abort" } }])
  controller.close()
})
