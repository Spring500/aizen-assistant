import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionRecord } from "../../packages/core/session-format.ts"
import { convertToLlm, serializeConversation, SessionManager } from "@earendil-works/pi-coding-agent"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { startMockServer } from "../utils/mock-server.ts"

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
    await runtime.create({ cwd: directory, model, view: { viewId: null } })
    const prompt = runtime.prompt({
      recordId: "running-record",
      turnId: "running-turn",
      viewId: null,
      items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "运行中" }] }],
    })
    const pending = await mock.take()

    await expect(runtime.restore({ cwd: directory, model, view: { viewId: null }, records: [] })).rejects.toThrow(
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
      await runtime.create({ cwd: directory, model, view: { viewId: null } })
      await runtime.prompt({
        recordId: "schema-record",
        turnId: "schema-turn",
        viewId: null,
        items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "检查工具参数" }] }],
      })

      const request = (await mock.requests())[0]
      expect(request?.tools).toHaveLength(4)
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
        model: { providerId: "deleted", modelId: "old-model", api: "openai-completions", thinkingLevel: "旧档位" },
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

    await expect(runtime.restore({ cwd: directory, model, view: { viewId: null }, records })).resolves.toBeDefined()
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

    await runtime.restore({ cwd: directory, model, view: { viewId: null }, records })
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
          source: { providerId: model.providerId, modelId: model.modelId, api: model.api },
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

    await runtime.restore({ cwd: directory, model, view: { viewId: "test", directory }, records })
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
          source: { providerId: model.providerId, modelId: model.modelId, api: model.api },
          stopReason: "aborted",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ]

    await runtime.restore({ cwd: directory, model, view: { viewId: "test", directory }, records })
    const request = await captureRequest(runtime, model)
    expect(request).toContain("已完成输入")
    expect(request).not.toContain("意外中断输入")
    expect(request).not.toContain("意外中断输出")
    await runtime.dispose()
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

    await runtime.create({ cwd: directory, model, view: { viewId: "review", directory: viewDirectory } })
    const firstRequest = await captureRequest(runtime, model)
    expect(firstRequest).toContain("视图系统甲")
    expect(firstRequest).toContain("项目规则甲")
    expect(firstRequest).toContain("review")

    await writeFile(join(viewDirectory, "SYSTEM.md"), "视图系统乙")
    await writeFile(join(viewDirectory, "AGENTS.md"), "项目规则乙")
    await runtime.refreshView({ viewId: "review", directory: viewDirectory })
    const secondRequest = await captureRequest(runtime, model)
    expect(secondRequest).toContain("视图系统乙")
    expect(secondRequest).toContain("项目规则乙")
    expect(secondRequest).not.toContain("视图系统甲")
    await runtime.dispose()
  })

  test("无视图会话使用内建提示词且不加载工作目录上下文", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find((item) => item.providerId === "anthropic")
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    await mkdir(join(directory, "skills", "hidden"), { recursive: true })
    await writeFile(join(directory, "SYSTEM.md"), "不应加载的系统提示词")
    await writeFile(join(directory, "AGENTS.md"), "不应加载的项目规则")
    await writeFile(join(directory, "skills", "hidden", "SKILL.md"), "---\nname: hidden\ndescription: 不应加载\n---\n")

    await runtime.create({ cwd: directory, model, view: { viewId: null } })
    const request = await captureRequest(runtime, model)
    expect(request).toContain("You are an expert coding assistant")
    expect(request).not.toContain("不应加载")
    expect(request).not.toContain("hidden")
    await runtime.dispose()
  })

  test("SYSTEM 缺失时采用 Pi 内建提示词", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find((item) => item.providerId === "anthropic")
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    await runtime.create({ cwd: directory, model, view: { viewId: "default", directory } })
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
      await runtime.create({ cwd: directory, model, view: { viewId: "test", directory } })
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
