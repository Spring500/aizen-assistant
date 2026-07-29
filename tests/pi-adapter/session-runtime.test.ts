import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionRecord } from "../../packages/core/session-format.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"

const directories: string[] = []

async function makeRuntime(): Promise<{ directory: string; runtime: PiSessionRuntime }> {
  const directory = await mkdtemp(join(tmpdir(), "aizen-pi-"))
  directories.push(directory)
  return {
    directory,
    runtime: await PiSessionRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null }),
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("pi 内存会话", () => {
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
    const messages = runtime.inspectMessages()
    expect(JSON.stringify(messages)).not.toContain("不要恢复")
    expect(JSON.stringify(messages)).toContain("需要恢复")
    expect(JSON.stringify(messages)).toContain("回复")
    expect(runtime.inspectSessionFile()).toBeUndefined()
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
    const messages = JSON.stringify(runtime.inspectMessages())
    expect(messages).toContain("已完成输入")
    expect(messages).not.toContain("意外中断输入")
    expect(messages).not.toContain("意外中断输出")
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
    expect(runtime.inspectSystemPrompt()).toContain("视图系统甲")
    expect(runtime.inspectSystemPrompt()).toContain("项目规则甲")
    expect(runtime.inspectSystemPrompt()).toContain("review")

    await writeFile(join(viewDirectory, "SYSTEM.md"), "视图系统乙")
    await writeFile(join(viewDirectory, "AGENTS.md"), "项目规则乙")
    await runtime.refreshView({ viewId: "review", directory: viewDirectory })
    expect(runtime.inspectSystemPrompt()).toContain("视图系统乙")
    expect(runtime.inspectSystemPrompt()).toContain("项目规则乙")
    expect(runtime.inspectSystemPrompt()).not.toContain("视图系统甲")
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
    expect(runtime.inspectSystemPrompt()).toContain("You are an expert coding assistant")
    expect(runtime.inspectSystemPrompt()).not.toContain("不应加载")
    expect(runtime.inspectSystemPrompt()).not.toContain("hidden")
    await runtime.dispose()
  })

  test("SYSTEM 缺失时采用 Pi 内建提示词", async () => {
    const { directory, runtime } = await makeRuntime()
    const model = (await runtime.listModels()).find((item) => item.providerId === "anthropic")
    expect(model).toBeDefined()
    if (!model) return
    await runtime.setRuntimeApiKey(model.providerId, "test-key")
    await runtime.create({ cwd: directory, model, view: { viewId: "default", directory } })
    expect(runtime.inspectSystemPrompt()).toContain("You are an expert coding assistant")
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
      runtime.subscribe((event) => {
        if (event.type === "message") messageEvents.push(event)
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
    } finally {
      server.stop(true)
      await runtime.dispose()
    }
  })
})
