import { afterEach, describe, expect } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { convertToLlm, SessionManager, serializeConversation } from "@earendil-works/pi-coding-agent"
import type { PiPortEvent, ResolvedViewResources } from "../../packages/core/pi-port.ts"
import type { SessionRecord } from "../../packages/core/session-format.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { startMockServer } from "../utils/mock-server.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const directories: string[] = []

async function makeRuntime(): Promise<{ directory: string; runtime: PiSessionRuntime }> {
  const directory = await mkdtemp(join(tmpdir(), "aizen-pi-"))
  directories.push(directory)
  return {
    directory,
    runtime: await PiSessionRuntime.create({ authPath: join(directory, "auth.json"), customProvidersPath: null }),
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const emptyView: ResolvedViewResources = { viewId: null, agentsFiles: [], skillPaths: [] }

/** 从视图目录读取 SYSTEM.md、AGENTS.md 与 skills/，构造 adapter 消费的装载资源。 */
function viewResources(directory: string, viewId: string): ResolvedViewResources {
  const agentsPath = join(directory, "AGENTS.md")
  const systemPath = join(directory, "SYSTEM.md")
  const skillsPath = join(directory, "skills")
  return {
    viewId,
    ...(existsSync(systemPath) ? { systemPrompt: readFileSync(systemPath, "utf8") } : {}),
    agentsFiles: existsSync(agentsPath) ? [{ path: agentsPath, content: readFileSync(agentsPath, "utf8") }] : [],
    skillPaths: existsSync(skillsPath) ? [skillsPath] : [],
  }
}

async function captureRequest(
  runtime: PiSessionRuntime,
  model: { providerId: string; modelId: string },
): Promise<string> {
  const mock = await startMockServer("完成")
  try {
    runtime.setModelBaseUrl(model.providerId, model.modelId, mock.url)
    await runtime.prompt({
      recordId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      viewId: null,
      items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "检查请求" }] }],
    })
    return JSON.stringify((await mock.requests())[0])
  } finally {
    mock.stop()
  }
}

describe("pi 内存会话", () => {
  test("请求运行期间拒绝重建会话和重载模型配置", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find((item) => item.providerId === "anthropic")
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    const mock = await startMockServer()
    runtime.setModelBaseUrl(model.providerId, model.modelId, mock.url)
    await runtime.create({ cwd: directory, model, view: emptyView })
    const prompt = runtime.prompt({
      recordId: "running-record",
      turnId: "running-turn",
      viewId: null,
      items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "运行中" }] }],
    })
    const pending = await mock.take()

    await expect(runtime.restore({ cwd: directory, model, view: emptyView, records: [] })).rejects.toThrow(
      "生成或执行工具期间不能重建会话",
    )
    await expect(runtime.reloadModelConfig()).rejects.toThrow("生成或执行工具期间不能重新加载模型配置")
    pending.respond({ type: "text", text: "完成" })
    await prompt
    mock.stop()
    await runtime.dispose()
  })

  test("审计工具向模型发送根级对象参数", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find((item) => item.providerId === "anthropic")
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    const mock = await startMockServer("完成")
    try {
      runtime.setModelBaseUrl(model.providerId, model.modelId, mock.url)
      await runtime.create({ cwd: directory, model, view: emptyView })
      await runtime.prompt({
        recordId: "schema-record",
        turnId: "schema-turn",
        viewId: null,
        items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "检查工具参数" }] }],
      })

      const request = (await mock.requests())[0]
      expect(request?.tools).toHaveLength(7)
      expect((request?.tools as Array<{ name?: string }> | undefined)?.map((tool) => tool.name)).toEqual([
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
      ])
      for (const item of request?.tools ?? []) {
        const tool = item as { input_schema?: Record<string, unknown> }
        expect(tool.input_schema?.type).toBe("object")
        expect(tool.input_schema?.properties).toHaveProperty("declaredIntent")
        expect(tool.input_schema?.required).toContain("declaredIntent")
        expect(tool.input_schema).not.toHaveProperty("allOf")
      }
      const read = (
        request?.tools as Array<{ name?: string; input_schema?: Record<string, unknown> }> | undefined
      )?.find((tool) => tool.name === "read")
      expect(read?.input_schema?.properties).toHaveProperty("path")
      expect(read?.input_schema?.required).toContain("path")
    } finally {
      mock.stop()
      await runtime.dispose()
    }
  })

  test("历史中的失效模型不阻止使用当前有效模型恢复", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find((item) => item.providerId === "anthropic")
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    const records: SessionRecord[] = [
      {
        kind: "model_changed",
        recordId: "old-model",
        at: "2026-07-23T09:00:00.000Z",
        model: { providerId: "deleted", modelId: "old-model", thinkingLevel: "旧档位" },
      },
      {
        kind: "turn_started",
        recordId: "turn",
        turnId: "turn",
        at: "2026-07-23T10:00:00.000Z",
        viewId: null,
        items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "历史消息" }] }],
      },
      {
        kind: "turn_finished",
        recordId: "finished",
        turnId: "turn",
        at: "2026-07-23T10:00:01.000Z",
        outcome: "completed",
      },
    ]

    await expect(runtime.restore({ cwd: directory, model, view: emptyView, records })).resolves.toBeDefined()
    expect(await captureRequest(runtime, model)).toContain("历史消息")
    await runtime.dispose()
  })

  test("目录变化记录作为可压缩的自定义消息恢复", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find((item) => item.providerId === "anthropic")
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    const records: SessionRecord[] = [
      {
        kind: "working_directory_changed",
        recordId: "cwd-change",
        at: "2026-07-23T10:00:00.000Z",
        previousCwd: "E:\\old",
        currentCwd: directory,
      },
    ]

    await runtime.restore({ cwd: directory, model, view: emptyView, records })
    const request = JSON.parse(await captureRequest(runtime, model)) as {
      body: { messages: Array<{ content: Array<{ text?: string }> }> }
    }
    expect(request.body.messages[0]?.content[0]?.text).toBe(
      `Working directory changed from "E:\\old" to "${directory}".`,
    )
    await runtime.dispose()
  })

  test("pi压缩会纳入工作目录变化自定义消息", () => {
    const manager = SessionManager.inMemory("D:\\new")
    manager.appendCustomMessageEntry(
      "working-directory-change",
      'Working directory changed from "E:\\old" to "D:\\new".',
      true,
    )
    const serialized = serializeConversation(convertToLlm(manager.buildSessionContext().messages))
    expect(serialized).toContain('[User]: Working directory changed from "E:\\old" to "D:\\new".')
  })

  test("恢复时排除仅当轮输入并保留助手和工具结果", async () => {
    const { directory, runtime } = await makeRuntime()
    const models = await runtime.listModels()
    const model = models.find((item) => item.providerId === "anthropic")
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")

    const records: SessionRecord[] = [
      {
        kind: "turn_started",
        recordId: "r1",
        turnId: "t1",
        at: "2026-07-23T10:00:00.000Z",
        viewId: null,
        items: [
          { source: "memory", role: "user", useLater: false, parts: [{ kind: "text", text: "不要恢复" }] },
          { source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "需要恢复" }] },
        ],
      },
      {
        kind: "message",
        recordId: "r2",
        turnId: "t1",
        at: "2026-07-23T10:00:01.000Z",
        message: {
          role: "assistant",
          parts: [{ kind: "text", text: "回复" }],
          source: { providerId: model.providerId, modelId: model.modelId, api: "anthropic-messages" },
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      },
      {
        kind: "turn_finished",
        recordId: "r3",
        turnId: "t1",
        at: "2026-07-23T10:00:02.000Z",
        outcome: "completed",
      },
    ]

    await runtime.restore({ cwd: directory, model, view: viewResources(directory, "test"), records })
    const request = await captureRequest(runtime, model)
    expect(request).not.toContain("不要恢复")
    expect(request).toContain("需要恢复")
    expect(request).toContain("回复")
    expect((await readdir(directory)).some((name) => name.endsWith(".jsonl"))).toBe(false)
    await runtime.dispose()
  })

  test("恢复时排除意外中断的整个轮次", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find((item) => item.providerId === "anthropic")
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    const records: SessionRecord[] = [
      {
        kind: "turn_started",
        recordId: "r1",
        turnId: "finished",
        at: "2026-07-23T10:00:00.000Z",
        viewId: null,
        items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "已完成输入" }] }],
      },
      {
        kind: "turn_finished",
        recordId: "r2",
        turnId: "finished",
        at: "2026-07-23T10:00:01.000Z",
        outcome: "completed",
      },
      {
        kind: "turn_started",
        recordId: "r3",
        turnId: "crashed",
        at: "2026-07-23T10:00:02.000Z",
        viewId: null,
        items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "意外中断输入" }] }],
      },
      {
        kind: "message",
        recordId: "r4",
        turnId: "crashed",
        at: "2026-07-23T10:00:03.000Z",
        message: {
          role: "assistant",
          parts: [{ kind: "text", text: "意外中断输出" }],
          source: { providerId: model.providerId, modelId: model.modelId, api: "anthropic-messages" },
          stopReason: "aborted",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ]

    await runtime.restore({ cwd: directory, model, view: viewResources(directory, "test"), records })
    const request = await captureRequest(runtime, model)
    expect(request).toContain("已完成输入")
    expect(request).not.toContain("意外中断输入")
    expect(request).not.toContain("意外中断输出")
    await runtime.dispose()
  })

  test("手动压缩生成核心边界事件并重建上下文", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find(
      (item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6",
    )
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    const mock = await startMockServer()
    mock.handle((request) => ({
      type: "text",
      text: JSON.stringify(request.system).includes("context summarization assistant") ? "压缩摘要" : "完成",
    }))
    runtime.setModelBaseUrl(model.providerId, model.modelId, mock.url)
    const records: SessionRecord[] = [
      {
        kind: "turn_started",
        recordId: "old-user",
        turnId: "old-turn",
        at: "2026-07-23T10:00:00.000Z",
        viewId: null,
        items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "旧目标" }] }],
      },
      {
        kind: "message",
        recordId: "old-assistant",
        turnId: "old-turn",
        at: "2026-07-23T10:00:01.000Z",
        message: {
          role: "assistant",
          parts: [{ kind: "text", text: "旧回复" }],
          source: { providerId: model.providerId, modelId: model.modelId, api: "anthropic-messages" },
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      },
      {
        kind: "turn_finished",
        recordId: "old-finished",
        turnId: "old-turn",
        at: "2026-07-23T10:00:02.000Z",
        outcome: "completed",
      },
      {
        kind: "turn_started",
        recordId: "recent-user",
        turnId: "recent-turn",
        at: "2026-07-23T10:01:00.000Z",
        viewId: null,
        items: [
          {
            source: "user",
            role: "user",
            useLater: true,
            parts: [{ kind: "text", text: `近期内容${"x".repeat(80000)}` }],
          },
        ],
      },
      {
        kind: "turn_finished",
        recordId: "recent-finished",
        turnId: "recent-turn",
        at: "2026-07-23T10:01:01.000Z",
        outcome: "completed",
      },
    ]
    const events: PiPortEvent[] = []
    runtime.subscribe((event) => events.push(event))
    await runtime.restore({ cwd: directory, model, view: emptyView, records })
    await runtime.compact("保留目标")
    expect(events).toContainEqual({
      type: "compaction",
      summary: "压缩摘要",
      firstKeptRecordId: "recent-user",
      tokensBefore: expect.any(Number),
    })
    await runtime.dispose()
    mock.stop()
  })

  test("达到pi默认阈值时先自动压缩再发送下一轮", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find(
      (item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6",
    )
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    const mock = await startMockServer()
    mock.handle((request) => ({
      type: "text",
      text: JSON.stringify(request.system).includes("context summarization assistant") ? "自动摘要" : "新回复",
    }))
    runtime.setModelBaseUrl(model.providerId, model.modelId, mock.url)
    const records: SessionRecord[] = [
      {
        kind: "turn_started",
        recordId: "old-user",
        turnId: "old-turn",
        at: "2026-07-23T10:00:00.000Z",
        viewId: null,
        items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "应被替代的旧消息" }] }],
      },
      {
        kind: "message",
        recordId: "old-assistant",
        turnId: "old-turn",
        at: "2026-07-23T10:00:01.000Z",
        message: {
          role: "assistant",
          parts: [{ kind: "text", text: "旧回复" }],
          source: { providerId: model.providerId, modelId: model.modelId, api: "anthropic-messages" },
          stopReason: "stop",
          usage: { input: model.contextWindow ?? 1000000, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      },
      {
        kind: "turn_finished",
        recordId: "old-finished",
        turnId: "old-turn",
        at: "2026-07-23T10:00:02.000Z",
        outcome: "completed",
      },
      {
        kind: "turn_started",
        recordId: "recent-user",
        turnId: "recent-turn",
        at: "2026-07-23T10:01:00.000Z",
        viewId: null,
        items: [
          {
            source: "user",
            role: "user",
            useLater: true,
            parts: [{ kind: "text", text: `近期内容${"x".repeat(80000)}` }],
          },
        ],
      },
      {
        kind: "turn_finished",
        recordId: "recent-finished",
        turnId: "recent-turn",
        at: "2026-07-23T10:01:01.000Z",
        outcome: "completed",
      },
    ]
    const events: PiPortEvent[] = []
    runtime.subscribe((event) => events.push(event))
    await runtime.restore({ cwd: directory, model, view: emptyView, records })
    await runtime.prompt({
      recordId: "new-user",
      turnId: "new-turn",
      viewId: null,
      items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "新问题" }] }],
    })
    expect(events.some((event) => event.type === "compaction" && event.summary === "自动摘要")).toBe(true)
    const requests = await mock.requests()
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain("自动摘要")
    expect(JSON.stringify(requests[1])).not.toContain("应被替代的旧消息")
    expect(JSON.stringify(requests[1])).toContain("新问题")
    const compacted = events.find((event) => event.type === "compaction")
    expect(compacted?.type).toBe("compaction")
    await runtime.dispose()
    if (compacted?.type === "compaction") {
      const restored = await PiSessionRuntime.create({
        authPath: join(directory, "auth.json"),
        customProvidersPath: null,
      })
      await restored.setRuntimeApiKey(model.providerId, "test-key")
      restored.setModelBaseUrl(model.providerId, model.modelId, mock.url)
      await restored.restore({
        cwd: directory,
        model,
        view: emptyView,
        records: [
          ...records,
          {
            kind: "compaction",
            recordId: "compaction-record",
            at: "2026-07-23T10:02:00.000Z",
            summary: compacted.summary,
            firstKeptRecordId: compacted.firstKeptRecordId,
            tokensBefore: compacted.tokensBefore,
          },
        ],
      })
      await restored.prompt({
        recordId: "restored-user",
        turnId: "restored-turn",
        viewId: null,
        items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "恢复后问题" }] }],
      })
      const restoredRequest = (await mock.requests()).at(-1)
      expect(JSON.stringify(restoredRequest)).toContain("自动摘要")
      expect(JSON.stringify(restoredRequest)).not.toContain("应被替代的旧消息")
      expect(JSON.stringify(restoredRequest)).toContain("恢复后问题")
      await restored.dispose()
    }
    mock.stop()
  })

  test("上下文溢出时压缩并只重试一次且保留当轮临时输入", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find(
      (item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6",
    )
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    const mock = await startMockServer()
    let conversationRequests = 0
    mock.handle((request) => {
      if (JSON.stringify(request.system).includes("context summarization assistant"))
        return { type: "text", text: "溢出摘要" }
      conversationRequests++
      if (conversationRequests === 1)
        return {
          type: "http_error",
          status: 400,
          body: { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } },
        }
      return { type: "text", text: "重试成功" }
    })
    runtime.setModelBaseUrl(model.providerId, model.modelId, mock.url)
    const records: SessionRecord[] = [
      {
        kind: "turn_started",
        recordId: "old-user",
        turnId: "old-turn",
        at: "2026-07-23T10:00:00.000Z",
        viewId: null,
        items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "旧消息" }] }],
      },
      {
        kind: "turn_finished",
        recordId: "old-finished",
        turnId: "old-turn",
        at: "2026-07-23T10:00:01.000Z",
        outcome: "completed",
      },
      {
        kind: "turn_started",
        recordId: "recent-user",
        turnId: "recent-turn",
        at: "2026-07-23T10:01:00.000Z",
        viewId: null,
        items: [
          {
            source: "user",
            role: "user",
            useLater: true,
            parts: [{ kind: "text", text: `近期内容${"x".repeat(80000)}` }],
          },
        ],
      },
      {
        kind: "turn_finished",
        recordId: "recent-finished",
        turnId: "recent-turn",
        at: "2026-07-23T10:01:01.000Z",
        outcome: "completed",
      },
    ]
    const events: PiPortEvent[] = []
    runtime.subscribe((event) => events.push(event))
    await runtime.restore({ cwd: directory, model, view: emptyView, records })
    await runtime.prompt({
      recordId: "overflow-user",
      turnId: "overflow-turn",
      viewId: null,
      items: [
        { source: "memory", role: "user", useLater: false, parts: [{ kind: "text", text: "仅本轮临时上下文" }] },
        { source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "溢出问题" }] },
      ],
    })
    expect(conversationRequests).toBe(2)
    expect(events.some((event) => event.type === "compaction" && event.summary === "溢出摘要")).toBe(true)
    const requests = await mock.requests()
    const retryRequest = requests.at(-1)
    expect(JSON.stringify(retryRequest)).toContain("溢出摘要")
    expect(JSON.stringify(retryRequest)).toContain("仅本轮临时上下文")
    expect(JSON.stringify(retryRequest)).toContain("溢出问题")
    expect(JSON.stringify(retryRequest)).not.toContain("旧消息")
    await runtime.dispose()
    mock.stop()
  })

  test("视图按轮重载 SYSTEM、AGENTS 和 Skill", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find((item) => item.providerId === "anthropic")
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    const viewDirectory = join(directory, "view")
    const skillDirectory = join(viewDirectory, "skills", "review")
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(join(viewDirectory, "SYSTEM.md"), "视图系统甲")
    await writeFile(join(viewDirectory, "AGENTS.md"), "项目规则甲")
    await writeFile(join(skillDirectory, "SKILL.md"), "---\nname: review\ndescription: 审查代码\n---\n")

    await runtime.create({ cwd: directory, model, view: viewResources(viewDirectory, "review") })
    const firstRequest = await captureRequest(runtime, model)
    expect(firstRequest).toContain("视图系统甲")
    expect(firstRequest).toContain("项目规则甲")
    expect(firstRequest).toContain("review")

    await writeFile(join(viewDirectory, "SYSTEM.md"), "视图系统乙")
    await writeFile(join(viewDirectory, "AGENTS.md"), "项目规则乙")
    await runtime.refreshView(viewResources(viewDirectory, "review"))
    const secondRequest = await captureRequest(runtime, model)
    expect(secondRequest).toContain("视图系统乙")
    expect(secondRequest).toContain("项目规则乙")
    expect(secondRequest).not.toContain("视图系统甲")
    await runtime.dispose()
  })

  test("空资源视图只加载内建提示词", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find((item) => item.providerId === "anthropic")
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    await mkdir(join(directory, "skills", "hidden"), { recursive: true })
    await writeFile(join(directory, "SYSTEM.md"), "不应加载的系统提示词")
    await writeFile(join(directory, "AGENTS.md"), "不应加载的项目规则")
    await writeFile(join(directory, "skills", "hidden", "SKILL.md"), "---\nname: hidden\ndescription: 不应加载\n---\n")

    await runtime.create({ cwd: directory, model, view: emptyView })
    const request = await captureRequest(runtime, model)
    expect(request).toContain("You are an expert coding assistant")
    expect(request).not.toContain("不应加载")
    expect(request).not.toContain("hidden")
    await runtime.dispose()
  })

  test("无视图原生模式加载项目上下文与用户技能", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find((item) => item.providerId === "anthropic")
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    const projectAgents = join(directory, "AGENTS.md")
    const projectSkills = join(directory, "skills")
    await writeFile(projectAgents, "项目规则")
    await mkdir(join(projectSkills, "helper"), { recursive: true })
    await writeFile(join(projectSkills, "helper", "SKILL.md"), "---\nname: helper\ndescription: 辅助\n---\n")

    await runtime.create({
      cwd: directory,
      model,
      view: {
        viewId: null,
        agentsFiles: [{ path: projectAgents, content: "项目规则" }],
        skillPaths: [projectSkills],
      },
    })
    const request = await captureRequest(runtime, model)
    expect(request).toContain("项目规则")
    expect(request).toContain("helper")
    await runtime.dispose()
  })

  test("SYSTEM 缺失时采用 Pi 内建提示词", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find((item) => item.providerId === "anthropic")
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    await runtime.create({ cwd: directory, model, view: viewResources(directory, "default") })
    expect(await captureRequest(runtime, model)).toContain("You are an expert coding assistant")
    await runtime.dispose()
  })

  test("新请求把用户记录与完成消息映射到 pi 条目", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find(
      (item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6",
    )
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `${[
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], model: model.modelId, usage: { input_tokens: 1, output_tokens: 1 } } })}`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "回复" } })}`,
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}`,
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
          ].join("\n\n")}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    try {
      runtime.setModelBaseUrl(model.providerId, model.modelId, `http://localhost:${server.port}`)
      await runtime.create({ cwd: directory, model, view: viewResources(directory, "test") })
      const messageEvents: Array<{
        recordId: string
        record: { role: string; parts?: Array<{ kind: string; timing?: { startedAt: number; finishedAt: number } }> }
      }> = []
      const usageEvents: Array<{ outputTokens: number; contextTokens?: number }> = []
      runtime.subscribe((event) => {
        if (event.type === "message") messageEvents.push(event)
        if (event.type === "usage_updated") usageEvents.push(event)
      })
      await runtime.prompt({
        recordId: "turn-record",
        turnId: "turn",
        viewId: null,
        items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "问题" }] }],
      })

      expect(messageEvents).toHaveLength(1)
      expect(messageEvents[0]?.recordId).toEqual(expect.any(String))
      expect(messageEvents[0]?.record.parts?.[0]?.timing).toEqual({
        startedAt: expect.any(Number),
        finishedAt: expect.any(Number),
      })
      expect(usageEvents.length).toBeGreaterThan(0)
      expect(usageEvents.every((event) => event.contextTokens === undefined)).toBe(true)
    } finally {
      server.stop(true)
      await runtime.dispose()
    }
  })
})
