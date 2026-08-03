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
    batchId: "batch",
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
      findings: [],
      details: toolName === "bash" ? { command: "npm install" } : { content: "完整正文" },
    },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  }
}

async function setupReview(requests = [request("one", "bash")]) {
  const setup = await createTestRenderer({ width: 100, height: 28 })
  renderers.push(setup)
  const overlays = new OverlayManager(setup.renderer)
  const answers: PermissionReviewAnswer[] = []
  const controller = createPermissionReviewView(overlays, requests, (answer) => {
    answers.push(answer)
  })
  await setup.renderOnce()
  return { setup, answers, controller }
}

test("审批页逐项决定后进入汇总并统一提交", async () => {
  const { setup, answers, controller } = await setupReview()
  let frame = setup.captureCharFrame()
  expect(frame).toContain("工具权限审核 · 工具 1/1")
  expect(frame).toContain("通过")
  expect(frame).toContain("拒绝理由")
  expect(frame).toContain("查看完整命令")

  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("不允许修改依赖"))
  await setup.renderOnce()
  frame = setup.captureCharFrame()
  expect(frame).toContain("拒绝理由  不允许修改依赖")
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  await setup.renderOnce()
  expect(answers).toEqual([])
  expect(setup.captureCharFrame()).toContain("工具权限审核 · 汇总 1 项")
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  expect(answers).toEqual([
    {
      decision: "submit",
      batchId: "batch",
      answers: [{ requestId: "one", decision: "deny", reason: "不允许修改依赖" }],
    },
  ])
  controller.close()
})

test("左右键切换工具页并保留拒绝理由草稿", async () => {
  const { setup, controller } = await setupReview([request("one", "bash"), request("two", "write")])
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("保留草稿"))
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("\x1b[C"))
  await Bun.sleep(1)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("工具权限审核 · 工具 2/2")
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("\x1b[D"))
  await Bun.sleep(1)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("拒绝理由  保留草稿")
  controller.close()
})

test("审批页展示判定原因和结构化 findings", async () => {
  const value = request("finding", "bash")
  value.assessment.findings = [
    { severity: "high", category: "system-mutation", summary: "修改系统状态", evidence: "sudo rm file" },
  ]
  const { setup, controller } = await setupReview([value])
  const frame = setup.captureCharFrame()
  expect(frame).toContain("判定原因：需要确认")
  expect(frame).toContain("[高] 修改系统状态")
  expect(frame).toContain("证据：sudo rm file")
  controller.close()
})

test("edit 完整详情使用 unified diff 专用页面", async () => {
  const value = request("edit-diff", "edit")
  value.assessment.details = {
    path: "source.ts",
    edits: [{ oldText: "const oldValue = 1", newText: "const newValue = 2" }],
    patch: "--- source.ts\t原文件\n+++ source.ts\t预览\n@@ -1,1 +1,1 @@\n-const oldValue = 1\n+const newValue = 2\n",
  }
  const { setup, controller } = await setupReview([value])
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("编辑预览：")
  expect(frame).toContain("const oldValue = 1")
  expect(frame).toContain("const newValue = 2")
  controller.close()
})

test("审批参数 Header 在 resize 后重新计算换行与省略", async () => {
  const long = request("resize", "bash")
  long.arguments = { command: `echo HEAD ${"middle ".repeat(20)}echo TAIL` }
  const { setup, controller } = await setupReview([long])
  setup.renderer.resize(44, 28)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("省略")
  setup.renderer.resize(180, 28)
  await setup.renderOnce()
  const wide = setup.captureCharFrame()
  expect(wide).toContain("HEAD")
  expect(wide).toContain("TAIL")
  controller.close()
})

test("长命令完整阅览前禁用通过", async () => {
  const setup = await createTestRenderer({ width: 48, height: 28 })
  renderers.push(setup)
  const overlays = new OverlayManager(setup.renderer)
  const answers: PermissionReviewAnswer[] = []
  const long = request("long", "bash")
  long.arguments = { command: `echo HEAD ${"middle ".repeat(100)} echo TAIL` }
  const controller = createPermissionReviewView(overlays, [long], (answer) => {
    answers.push(answer)
  })
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("省略")
  expect(frame).toContain("请先打开完整内容")
  setup.renderer.keyInput.emit("keypress", key("\r"))
  expect(answers).toEqual([])
  controller.close()
})

test("长命令滚动到详情末尾后允许通过并在汇总提交", async () => {
  const setup = await createTestRenderer({ width: 48, height: 28 })
  renderers.push(setup)
  const overlays = new OverlayManager(setup.renderer)
  const answers: PermissionReviewAnswer[] = []
  const long = request("unlock", "bash")
  long.arguments = { command: `echo HEAD ${"middle ".repeat(200)} echo TAIL` }
  const controller = createPermissionReviewView(overlays, [long], (answer) => {
    answers.push(answer)
  })
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  for (let index = 0; index < 20; index++) setup.renderer.keyInput.emit("keypress", key("\x1b[6~"))
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  expect(answers).toEqual([
    { decision: "submit", batchId: "batch", answers: [{ requestId: "unlock", decision: "approve" }] },
  ])
  controller.close()
})

test("审批页Esc请求中止整轮", async () => {
  const { setup, answers, controller } = await setupReview()
  setup.renderer.keyInput.emit("keypress", key("\x1b"))
  await Bun.sleep(1)
  expect(answers).toEqual([{ decision: "abort", batchId: "batch" }])
  controller.close()
})
