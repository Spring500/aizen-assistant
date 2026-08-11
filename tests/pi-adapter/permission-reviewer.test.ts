import { afterEach, expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { PiPermissionReviewer } from "../../packages/pi-adapter/permission-reviewer.ts"
import { startMockServer, type MockServer } from "../utils/mock-server.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const servers: MockServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

async function setup() {
  const mock = await startMockServer({ modelBehaviors: { "claude-haiku-4-5": "test-control" } })
  servers.push(mock)
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
  await runtime.setRuntimeApiKey("anthropic", "test-key")
  const source = runtime.getModel("anthropic", "claude-haiku-4-5")
  if (!source) throw new Error("缺少测试审核模型")
  return { mock, reviewer: new PiPermissionReviewer(runtime, { ...source, baseUrl: mock.url }) }
}

const request = {
  toolName: "bash",
  declaredIntent: "下载公开说明",
  cwd: "/project",
  validatorDecision: "needAiReview" as const,
  assessment: {
    summary: "curl https://example.com",
    targets: ["https://example.com"],
    reason: "网络请求",
    tags: [{ tag: "network-fetch", name: "Fetch data from the network", evidence: "curl https://example.com" }],
  },
  payload: { command: "curl https://example.com" },
}

test("审核请求只包含局部工具信息并解析结构化结论", async () => {
  const { mock, reviewer } = await setup()
  const reviewing = reviewer.review(request)
  const captured = await mock.take({ modelId: "claude-haiku-4-5" })
  const serialized = JSON.stringify(captured.messages)
  expect(serialized).toContain("下载公开说明")
  expect(serialized).toContain("curl https://example.com")
  expect(serialized).toContain("needAiReview")
  expect(serialized).toContain("Fetch data from the network")
  expect(serialized).not.toContain("主对话历史")
  expect(JSON.stringify(captured.tools)).toContain("submit_permission_review")
  captured.respond({
    type: "tool_call",
    name: "submit_permission_review",
    arguments: { decision: "needHumanReview", reason: "需要用户判断网络目标" },
  })
  expect(await reviewing).toEqual({ type: "needHumanReview", reason: "需要用户判断网络目标" })
})

test("无效审核输出会纠正并在连续失败后报错", async () => {
  const { mock, reviewer } = await setup()
  mock.handleModel("claude-haiku-4-5", () => ({ type: "text", text: "普通文本" }))
  await expect(reviewer.review(request)).rejects.toThrow("连续 2 次")
  expect(await mock.requests()).toHaveLength(2)
})
