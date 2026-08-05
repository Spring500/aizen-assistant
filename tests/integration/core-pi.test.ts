import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import { AppPreferencesStore } from "../../packages/core/app-preferences-store.ts"
import type { ModelReference } from "../../packages/core/session-format.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { startMockServer } from "../utils/mock-server.ts"

const directories: string[] = []

type StageDetails = () => Record<string, unknown>

async function traceStage<T>(name: string, operation: () => Promise<T>, details?: StageDetails): Promise<T> {
  const startedAt = performance.now()
  console.log(`[core-pi] 开始：${name}`)
  const diagnostics = [5000, 10000, 15000, 20000, 25000].map((delay) =>
    setTimeout(() => {
      const elapsed = Math.round(performance.now() - startedAt)
      const currentDetails = details?.()
      console.log(
        `[core-pi] 等待：${name}，已耗时 ${elapsed}ms${currentDetails ? `，状态 ${JSON.stringify(currentDetails)}` : ""}`,
      )
    }, delay),
  )
  try {
    const result = await operation()
    console.log(`[core-pi] 完成：${name}，耗时 ${Math.round(performance.now() - startedAt)}ms`)
    return result
  } catch (error) {
    console.error(
      `[core-pi] 失败：${name}，耗时 ${Math.round(performance.now() - startedAt)}ms，错误 ${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  } finally {
    for (const diagnostic of diagnostics) clearTimeout(diagnostic)
  }
}

function coreDetails(core: AizenCore): Record<string, unknown> {
  const snapshot = core.getSnapshot()
  return {
    status: snapshot.status,
    transcriptEntries: snapshot.transcript.length,
    activeTools: snapshot.activeTools.map((tool) => ({ name: tool.name, isFinished: tool.isFinished })),
    streamingTextLength: snapshot.streamingText.length,
    streamingThinkingLength: snapshot.streamingThinking.length,
    lastError: snapshot.lastError,
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("真实 pi 链路完成两轮并恢复第三轮", async () => {
  const root = await traceStage("创建临时目录", () => mkdtemp(join(tmpdir(), "aizen-integration-")))
  directories.push(root)
  const mock = await traceStage("启动 mock server", () => startMockServer("完成"))
  try {
    const pi = await traceStage("创建首次 pi runtime", () =>
      PiSessionRuntime.create({ authPath: join(root, "auth.json"), customProvidersPath: null }),
    )
    await traceStage("配置首次 runtime 认证", () => pi.setRuntimeApiKey("anthropic", "test-key"))
    const models = await traceStage("读取首次 runtime 模型", () => pi.listModels())
    const option = models.find((item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6")
    expect(option).toBeDefined()
    if (!option) return
    const builtIn = { ...option, baseUrl: mock.url }
    pi.setModelBaseUrl(builtIn.providerId, builtIn.modelId, mock.url)
    console.log("[core-pi] 完成：配置首次 runtime mock 地址")
    const model: ModelReference = option
    const store = new SessionStore(join(root, "sessions"))
    const core = new AizenCore({ cwd: root, store, pi })
    const createResult = await traceStage(
      "创建会话",
      () => core.dispatch({ type: "create_session", model, viewId: null }),
      () => coreDetails(core),
    )
    expect(createResult.ok).toBe(true)
    const sessionId = core.getSnapshot().currentSessionId
    const firstResult = await traceStage(
      "发送第一轮",
      () => core.dispatch({ type: "send_prompt", text: "第一轮" }),
      () => coreDetails(core),
    )
    expect(firstResult.ok).toBe(true)
    const secondResult = await traceStage(
      "发送第二轮",
      () => core.dispatch({ type: "send_prompt", text: "第二轮" }),
      () => coreDetails(core),
    )
    expect(secondResult.ok).toBe(true)
    await traceStage(
      "释放首次 core",
      () => core.dispose(),
      () => coreDetails(core),
    )

    const restoredPi = await traceStage("创建恢复 pi runtime", () =>
      PiSessionRuntime.create({ authPath: join(root, "auth.json"), customProvidersPath: null }),
    )
    await traceStage("配置恢复 runtime 认证", () => restoredPi.setRuntimeApiKey("anthropic", "test-key"))
    restoredPi.setModelBaseUrl(option.providerId, option.modelId, mock.url)
    console.log("[core-pi] 完成：配置恢复 runtime mock 地址")
    const restored = new AizenCore({ cwd: root, store, pi: restoredPi })
    const openResult = await traceStage(
      "恢复会话",
      () => restored.dispatch({ type: "open_session", sessionId: sessionId ?? "" }),
      () => coreDetails(restored),
    )
    expect(openResult.ok).toBe(true)
    const thirdResult = await traceStage(
      "发送第三轮",
      () => restored.dispatch({ type: "send_prompt", text: "第三轮" }),
      () => coreDetails(restored),
    )
    expect(thirdResult.ok).toBe(true)
    await traceStage(
      "释放恢复 core",
      () => restored.dispose(),
      () => coreDetails(restored),
    )

    const requests = await traceStage("读取 mock 请求记录", () => mock.requests())
    console.log(`[core-pi] 完成：校验请求记录，共 ${requests.length} 条`)
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[1])).toContain("第一轮")
    expect(JSON.stringify(requests[2])).toContain("第二轮")
  } finally {
    mock.stop()
  }
}, 30000)

test("真实 pi 链路将权限拒绝结果返回模型", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-integration-"))
  directories.push(root)
  const mock = await startMockServer()
  try {
    const pi = await PiSessionRuntime.create({ authPath: join(root, "auth.json"), customProvidersPath: null })
    await pi.setRuntimeApiKey("anthropic", "test-key")
    const models = await pi.listModels()
    const option = models.find((item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6")
    if (!option) throw new Error("缺少集成测试模型")
    pi.setModelBaseUrl(option.providerId, option.modelId, mock.url)
    const core = new AizenCore({ cwd: root, store: new SessionStore(join(root, "sessions")), pi })
    await core.dispatch({ type: "create_session", model: option, viewId: null, permissionMode: "hybrid" })
    const sending = core.dispatch({ type: "send_prompt", text: "执行测试" })
    const first = await mock.take({ modelId: option.modelId })
    first.respond({
      type: "tool_call",
      name: "bash",
      arguments: { command: "sudo rm file", declaredIntent: "删除文件" },
      callId: "permission-call",
    })
    for (let attempt = 0; attempt < 50 && !core.getSnapshot().pendingPermissionRequests?.length; attempt++)
      await Bun.sleep(2)
    const pending = core.getSnapshot().pendingPermissionRequests?.[0]
    expect(pending?.toolCallId).toBe("permission-call")
    await core.dispatch({
      type: "answer_permission_request",
      requestId: pending?.requestId ?? "",
      decision: "deny",
    })
    const second = await mock.take({ modelId: option.modelId })
    const messages = JSON.stringify(second.messages)
    expect(messages).toContain("permission-call")
    expect(messages).toContain("Operation denied: User denied permission without providing a reason.")
    second.respond({ type: "text", text: "已停止操作" })
    expect(await sending).toEqual({ ok: true })
    expect(
      core.getSnapshot().transcript.some((entry) => entry.type === "message" && entry.message.role === "tool"),
    ).toBe(true)
    await core.dispose()
  } finally {
    mock.stop()
  }
}, 30000)

test("真实 pi 链路统一提交同一消息中的多工具人工审批", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-integration-batch-"))
  directories.push(root)
  const mock = await startMockServer()
  try {
    const pi = await PiSessionRuntime.create({ authPath: join(root, "auth.json"), customProvidersPath: null })
    await pi.setRuntimeApiKey("anthropic", "test-key")
    const models = await pi.listModels()
    const option = models.find((item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6")
    if (!option) throw new Error("缺少集成测试模型")
    pi.setModelBaseUrl(option.providerId, option.modelId, mock.url)
    const core = new AizenCore({ cwd: root, store: new SessionStore(join(root, "sessions")), pi })
    await core.dispatch({ type: "create_session", model: option, viewId: null, permissionMode: "hybrid" })
    const sending = core.dispatch({ type: "send_prompt", text: "执行两个需要确认的命令" })
    const first = await mock.take({ modelId: option.modelId })
    first.respond({
      type: "tool_calls",
      calls: [
        {
          name: "bash",
          arguments: { command: "echo $HOME", declaredIntent: "显示主目录" },
          callId: "batch-call-one",
        },
        {
          name: "bash",
          arguments: { command: "echo $PATH", declaredIntent: "显示搜索路径" },
          callId: "batch-call-two",
        },
      ],
    })
    for (let attempt = 0; attempt < 100 && core.getSnapshot().pendingPermissionRequests?.length !== 2; attempt++)
      await Bun.sleep(2)
    const pending = core.getSnapshot().pendingPermissionRequests ?? []
    expect(pending.map((request) => request.toolCallId)).toEqual(["batch-call-one", "batch-call-two"])
    expect(new Set(pending.map((request) => request.batchId)).size).toBe(1)
    expect(
      await core.dispatch({
        type: "answer_permission_batch",
        batchId: pending[0]?.batchId ?? "",
        answers: [
          { requestId: pending[0]?.requestId ?? "", type: "approve" },
          { requestId: pending[1]?.requestId ?? "", type: "deny", reason: "无需展示搜索路径" },
        ],
      }),
    ).toEqual({ ok: true })
    const second = await mock.take({ modelId: option.modelId })
    const messages = JSON.stringify(second.messages)
    expect(messages).toContain("batch-call-one")
    expect(messages).toContain("batch-call-two")
    expect(messages).toContain("Operation denied: User denied permission. Reason: 无需展示搜索路径")
    second.respond({ type: "text", text: "批次处理完成" })
    expect(await sending).toEqual({ ok: true })
    await core.dispose()
  } finally {
    mock.stop()
  }
}, 30000)

test("批次提交后中止会保留已完成项并停止运行项", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-integration-batch-abort-"))
  directories.push(root)
  const mock = await startMockServer()
  let slowStarted = false
  let slowAborted = false
  try {
    const pi = await PiSessionRuntime.create({ authPath: join(root, "auth.json"), customProvidersPath: null })
    await pi.setRuntimeApiKey("anthropic", "test-key")
    const models = await pi.listModels()
    const option = models.find((item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6")
    if (!option) throw new Error("缺少集成测试模型")
    pi.setModelBaseUrl(option.providerId, option.modelId, mock.url)
    const store = new SessionStore(join(root, "sessions"))
    const validator = (toolName: string) => ({
      toolName,
      validate: async () => ({
        type: "needHumanReview" as const,
        assessment: { summary: toolName, targets: [], risk: "medium" as const, reason: "测试人工审批", findings: [] },
      }),
    })
    const core = new AizenCore({
      cwd: root,
      store,
      pi,
      toolRegistrations: [
        {
          kind: "inProcess",
          descriptor: { name: "fast_tool", label: "fast", description: "快速完成", parameters: { type: "object" } },
          validator: validator("fast_tool"),
          execute: async () => ({ content: [{ type: "text", text: "fast completed" }] }),
        },
        {
          kind: "inProcess",
          descriptor: { name: "slow_tool", label: "slow", description: "等待中止", parameters: { type: "object" } },
          validator: validator("slow_tool"),
          execute: async ({ signal }) => {
            slowStarted = true
            await new Promise<void>((resolve, reject) => {
              if (signal?.aborted) {
                slowAborted = true
                reject(new Error("aborted"))
                return
              }
              signal?.addEventListener(
                "abort",
                () => {
                  slowAborted = true
                  reject(new Error("aborted"))
                },
                { once: true },
              )
              setTimeout(resolve, 10_000)
            })
            return { content: [{ type: "text", text: "slow completed" }] }
          },
        },
      ],
    })
    await core.dispatch({ type: "create_session", model: option, viewId: null, permissionMode: "hybrid" })
    const sessionId = core.getSnapshot().currentSessionId
    const sending = core.dispatch({ type: "send_prompt", text: "执行并中止两个工具" })
    const first = await mock.take({ modelId: option.modelId })
    first.respond({
      type: "tool_calls",
      calls: [
        { name: "fast_tool", arguments: { declaredIntent: "快速完成测试" }, callId: "fast-call" },
        { name: "slow_tool", arguments: { declaredIntent: "等待中止测试" }, callId: "slow-call" },
      ],
    })
    for (let attempt = 0; attempt < 100 && core.getSnapshot().pendingPermissionRequests?.length !== 2; attempt++)
      await Bun.sleep(2)
    const pending = core.getSnapshot().pendingPermissionRequests ?? []
    await core.dispatch({
      type: "answer_permission_batch",
      batchId: pending[0]?.batchId ?? "",
      answers: pending.map((request) => ({ requestId: request.requestId, type: "approve" as const })),
    })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (slowStarted && core.getSnapshot().activeTools.some((tool) => tool.callId === "fast-call" && tool.isFinished))
        break
      await Bun.sleep(2)
    }
    expect(slowStarted).toBe(true)
    expect(await core.dispatch({ type: "abort" })).toEqual({ ok: true })
    expect(await sending).toEqual({ ok: true })
    expect(slowAborted).toBe(true)
    const loaded = await store.read(sessionId ?? "")
    const executionEvents = loaded.records.filter(
      (record) =>
        record.kind === "tool_permission" &&
        !!record.event &&
        typeof record.event === "object" &&
        !Array.isArray(record.event),
    )
    expect(
      executionEvents.some(
        (record) =>
          record.kind === "tool_permission" &&
          !!record.event &&
          typeof record.event === "object" &&
          !Array.isArray(record.event) &&
          record.toolCallId === "fast-call" &&
          record.event.phase === "executionFinished" &&
          record.event.isError === false,
      ),
    ).toBe(true)
    expect(
      executionEvents.some(
        (record) =>
          record.kind === "tool_permission" &&
          !!record.event &&
          typeof record.event === "object" &&
          !Array.isArray(record.event) &&
          record.toolCallId === "slow-call" &&
          record.event.phase === "executionFinished" &&
          record.event.isError === true,
      ),
    ).toBe(true)
    await core.dispose()
  } finally {
    mock.stop()
  }
}, 30000)

test("真实 pi 链路执行项目自有联合注册工具", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-integration-registered-tool-"))
  directories.push(root)
  const mock = await startMockServer()
  try {
    const pi = await PiSessionRuntime.create({ authPath: join(root, "auth.json"), customProvidersPath: null })
    await pi.setRuntimeApiKey("anthropic", "test-key")
    const models = await pi.listModels()
    const option = models.find((item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6")
    if (!option) throw new Error("缺少集成测试模型")
    pi.setModelBaseUrl(option.providerId, option.modelId, mock.url)
    const core = new AizenCore({
      cwd: root,
      store: new SessionStore(join(root, "sessions")),
      pi,
      toolRegistrations: [
        {
          kind: "inProcess",
          descriptor: {
            name: "registered_echo",
            label: "registered_echo",
            description: "返回输入文本",
            parameters: {
              type: "object",
              properties: { text: { type: "string" }, declaredIntent: { type: "string" } },
              required: ["text", "declaredIntent"],
            },
          },
          validator: {
            toolName: "registered_echo",
            validate: async (request) => ({
              type: "allow",
              assessment: {
                summary: "返回输入文本",
                targets: [],
                risk: "low",
                reason: "无副作用",
                findings: [],
                normalizedArguments: request.arguments,
              },
            }),
          },
          execute: async ({ arguments: args }) => ({
            content: [
              {
                type: "text",
                text:
                  args && typeof args === "object" && !Array.isArray(args) && typeof args.text === "string"
                    ? args.text
                    : "",
              },
            ],
          }),
        },
      ],
    })
    await core.dispatch({ type: "create_session", model: option, viewId: null, permissionMode: "hybrid" })
    const sending = core.dispatch({ type: "send_prompt", text: "调用注册工具" })
    const first = await mock.take({ modelId: option.modelId })
    const registered = (first.tools as Array<{ name?: string; input_schema?: Record<string, unknown> }>).find(
      (tool) => tool.name === "registered_echo",
    )
    expect(registered?.input_schema?.properties).toHaveProperty("declaredIntent")
    expect(registered?.input_schema?.required).toContain("declaredIntent")
    first.respond({
      type: "tool_call",
      name: "registered_echo",
      arguments: { text: "联合注册成功", declaredIntent: "回显测试文本" },
      callId: "registered-call",
    })
    const second = await mock.take({ modelId: option.modelId })
    expect(JSON.stringify(second.messages)).toContain("联合注册成功")
    second.respond({ type: "text", text: "完成" })
    expect(await sending).toEqual({ ok: true })
    await core.dispose()
  } finally {
    mock.stop()
  }
}, 30000)

test("真实 pi 链路并行完成主回复和工具式自动命名", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-integration-"))
  directories.push(root)
  const mock = await startMockServer()
  try {
    mock.handleModel("claude-sonnet-4-6", () => ({ type: "text", text: "主回复完成" }))
    const pi = await PiSessionRuntime.create({ authPath: join(root, "auth.json"), customProvidersPath: null })
    await pi.setRuntimeApiKey("anthropic", "test-key")
    const models = await pi.listModels()
    const chat = models.find((item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6")
    const naming = models.find((item) => item.providerId === "anthropic" && item.modelId === "claude-haiku-4-5")
    if (!chat || !naming) throw new Error("缺少集成测试模型")
    pi.setModelBaseUrl(chat.providerId, chat.modelId, mock.url)
    pi.setModelBaseUrl(naming.providerId, naming.modelId, mock.url)
    const preferencesStore = new AppPreferencesStore(join(root, "preferences.json"))
    await preferencesStore.write({
      newSession: { viewId: null, permissionMode: "hybrid" },
      agents: {
        sessionNaming: { model: { providerId: naming.providerId, modelId: naming.modelId } },
        permissionReview: {},
      },
      fold: { thinkingExpanded: false, toolGroupExpanded: false, toolDetailsExpanded: false },
    })
    const core = new AizenCore({
      cwd: root,
      store: new SessionStore(join(root, "sessions")),
      pi,
      preferencesStore,
    })
    await core.dispatch({ type: "load_preferences" })
    await core.dispatch({ type: "create_session", model: chat, viewId: null })
    const sending = core.dispatch({ type: "send_prompt", text: "分析自动命名机制" })
    const titleRequest = await mock.take({ modelId: naming.modelId })
    expect(JSON.stringify(titleRequest.messages)).toContain("分析自动命名机制")
    expect(await sending).toEqual({ ok: true })
    expect(core.getSnapshot().currentSessionName).toBe("")
    titleRequest.respond({
      type: "tool_call",
      name: "set_session_title",
      arguments: { title: "自动命名机制分析" },
    })
    for (let attempt = 0; attempt < 20 && !core.getSnapshot().currentSessionName; attempt++) await Bun.sleep(5)
    expect(core.getSnapshot().currentSessionName).toBe("自动命名机制分析")
    await core.dispose()
  } finally {
    mock.stop()
  }
}, 30000)
