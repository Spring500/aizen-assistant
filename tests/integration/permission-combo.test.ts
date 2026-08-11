import { afterEach, expect } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import { AppPreferencesStore } from "../../packages/core/app-preferences-store.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { startMockServer, type MockServer } from "../utils/mock-server.ts"

const test = createDiagnosticTest({ timeoutMs: 60_000 })

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

type Combo = { preset: "plan" | "edit" | "all-right"; reviewMode: "manual" | "aiReview" | "aiReviewWithAbstain" }

/** 建立真实 pi 链路：会话模型 mock-dsl 行为，审核模型 mock-review 行为。 */
async function setup(combo: Combo): Promise<{ core: AizenCore; mock: MockServer }> {
  const root = await mkdtemp(join(tmpdir(), "aizen-permission-combo-"))
  directories.push(root)
  await writeFile(join(root, "probe.txt"), "x")
  await writeFile(join(root, "build.sh"), "echo built")
  await writeFile(join(root, ".env"), "TOKEN=test")
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src", "a.ts"), "export {}")
  const mock = await startMockServer({
    modelBehaviors: { "claude-sonnet-4-6": "dsl", "claude-haiku-4-5": "review" },
  })
  const preferencesStore = new AppPreferencesStore(join(root, "preferences.json"))
  await preferencesStore.write({
    newSession: { viewId: null, permissionPreset: combo.preset, permissionReviewMode: combo.reviewMode },
    agents: {
      sessionNaming: {},
      permissionReview: { model: { providerId: "anthropic", modelId: "claude-haiku-4-5" } },
    },
    fold: { thinkingExpanded: false, toolGroupExpanded: false, toolDetailsExpanded: false },
  })
  const pi = await PiSessionRuntime.create({ authPath: join(root, "auth.json"), customProvidersPath: null })
  await pi.setRuntimeApiKey("anthropic", "test-key")
  const models = await pi.listModels()
  const option = models.find((item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6")
  if (!option) throw new Error("缺少会话测试模型")
  pi.setModelBaseUrl("anthropic", "claude-sonnet-4-6", mock.url)
  pi.setModelBaseUrl("anthropic", "claude-haiku-4-5", mock.url)
  const core = new AizenCore({ cwd: root, store: new SessionStore(join(root, "sessions")), pi, preferencesStore })
  const created = await core.dispatch({
    type: "create_session",
    model: option,
    viewId: null,
    permissionPreset: combo.preset,
    permissionReviewMode: combo.reviewMode,
  })
  if (!created.ok) throw new Error("创建会话失败")
  return { core, mock }
}

/** 等待人工审批请求出现并统一批准。 */
async function approvePending(core: AizenCore): Promise<void> {
  for (let attempt = 0; attempt < 200 && !core.getSnapshot().pendingPermissionRequests?.length; attempt++)
    await Bun.sleep(25)
  const pending = core.getSnapshot().pendingPermissionRequests ?? []
  const batchId = pending[0]?.batchId
  if (!batchId) throw new Error("没有出现待审批请求")
  await core.dispatch({
    type: "answer_permission_batch",
    batchId,
    answers: pending.map((request) => ({ requestId: request.requestId, type: "approve" })),
  })
}

/** 从 mock 请求历史中拼接全部工具结果文本（tool_result 在 role=user 消息的 content 块中）。 */
async function toolResults(mock: MockServer): Promise<string> {
  const requests = await mock.requests()
  const parts: string[] = []
  for (const request of requests) {
    for (const message of Array.isArray(request.messages) ? request.messages : []) {
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        const item = part as { type?: unknown; content?: unknown }
        if (item.type !== "tool_result" || typeof item.content !== "string") continue
        parts.push(item.content)
      }
    }
  }
  return parts.join("\n")
}

async function runDsl(core: AizenCore, dsl: string): Promise<void> {
  const result = await core.dispatch({ type: "send_prompt", text: dsl })
  expect(result.ok).toBe(true)
}

test("edit+aiReview：网络上传走 AI 审核，暗语控制裁决", async () => {
  const { core, mock } = await setup({ preset: "edit", reviewMode: "aiReview" })
  try {
    await runDsl(
      core,
      "bash up2 上传构建产物（预期：AI审核通过并执行）[通过] | curl -s -X POST -d hello http://127.0.0.1:1/\n" +
        "bash up3 上传构建产物（预期：AI审核拒绝）[拒绝] | curl -s -X POST -d hello http://127.0.0.1:1/\n" +
        "text <<<\n结果：\n{{up2.Result}}\n{{up3.Result}}\n>>>",
    )
    const result = await toolResults(mock)
    // up2 [通过]：AI 放行后命令真实执行（curl 连接本地端口失败，返回 code 7）
    expect(result).toContain("Command exited with code 7")
    // up3 [拒绝]：AI 拒绝，模型收到 Operation denied
    expect(result).toContain("Operation denied")
  } finally {
    core.dispose()
    mock.stop()
  }
})

test("edit+aiReview：系统更改、凭据与脚本调用强制人工", async () => {
  const { core, mock } = await setup({ preset: "edit", reviewMode: "aiReview" })
  try {
    const sending = core.dispatch({
      type: "send_prompt",
      text:
        "bash svc1 系统更改（预期：人工） | chmod 644 probe.txt\n" +
        "read key1 读取凭据（预期：人工） | .env\n" +
        "bash scr1 运行脚本（预期：人工 unknown） | ./build.sh\n" +
        "text <<<\n结果：\n{{svc1.Result}}\n{{key1.Result}}\n{{scr1.Result}}\n>>>",
    })
    await approvePending(core)
    expect(await sending).toEqual({ ok: true })
    const result = await toolResults(mock)
    // 人工批准后三项全部执行：chmod 无输出、build.sh 输出 built，均不应出现权限拒绝
    expect(result).toContain("built")
    expect(result).not.toContain("Operation denied")
  } finally {
    core.dispose()
    mock.stop()
  }
})

test("plan+aiReview：修改类直接拒绝，violation 固定拒绝", async () => {
  const { core, mock } = await setup({ preset: "plan", reviewMode: "aiReview" })
  try {
    await runDsl(
      core,
      "bash del1 删除构建产物（预期：拒绝） | rm -rf ./dist\n" +
        'bash bad1 eval（预期：拒绝） | eval "echo ok"\n' +
        "bash ok1 只读（预期：通过） | echo hi\n" +
        "text <<<\n结果：\n{{del1.Result}}\n{{bad1.Result}}\n{{ok1.Result}}\n>>>",
    )
    const result = await toolResults(mock)
    // plan 档修改工作区直接拒绝（规则可读名），eval 判 violation 固定拒绝，echo 正面担保放行
    expect(result).toContain("Modify workspace files")
    expect(result).toContain("Unsafe operation")
    expect(result).toContain("hi")
  } finally {
    core.dispose()
    mock.stop()
  }
})

test("edit+manual：aiReview 档与 needHumanReview 档都走人工", async () => {
  const { core, mock } = await setup({ preset: "edit", reviewMode: "manual" })
  try {
    const sending = core.dispatch({
      type: "send_prompt",
      text:
        "bash up1 上传日志（预期：人工） | curl -s -X POST -d hello http://127.0.0.1:1/\n" +
        "text <<<\n结果：\n{{up1.Result}}\n>>>",
    })
    await approvePending(core)
    expect(await sending).toEqual({ ok: true })
    const result = await toolResults(mock)
    // manual 下网络上传走人工，批准后执行（curl 失败但未被权限拒绝）
    expect(result).not.toContain("Operation denied")
  } finally {
    core.dispose()
    mock.stop()
  }
})
