import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
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
        view: { viewId: "empty", contentHash: "sha256:abc" },
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

    await runtime.restore({ cwd: directory, model, view: { viewId: "empty", contentHash: "sha256:abc" }, records })
    const messages = runtime.inspectMessages()
    expect(JSON.stringify(messages)).not.toContain("不要恢复")
    expect(JSON.stringify(messages)).toContain("需要恢复")
    expect(JSON.stringify(messages)).toContain("回复")
    const mappings = runtime.inspectEntryMappings()
    expect(mappings.some((item) => item.runtimeRef === "r1")).toBe(true)
    expect(mappings.some((item) => item.runtimeRef === "r2")).toBe(true)
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
        view: { viewId: "empty", contentHash: "sha256:abc" },
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
        view: { viewId: "empty", contentHash: "sha256:abc" },
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

    await runtime.restore({ cwd: directory, model, view: { viewId: "empty", contentHash: "sha256:abc" }, records })
    const messages = JSON.stringify(runtime.inspectMessages())
    expect(messages).toContain("已完成输入")
    expect(messages).not.toContain("意外中断输入")
    expect(messages).not.toContain("意外中断输出")
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
      await runtime.create({ cwd: directory, model, view: { viewId: "empty", contentHash: "sha256:abc" } })
      const messageEvents: Array<{ runtimeRef: string }> = []
      runtime.subscribe((event) => {
        if (event.type === "message") messageEvents.push(event)
      })
      await runtime.prompt({
        recordId: "turn-record",
        turnId: "turn",
        view: { viewId: "empty", contentHash: "sha256:abc" },
        items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "问题" }] }],
      })

      const mappings = runtime.inspectEntryMappings()
      expect(mappings.some((item) => item.runtimeRef === "turn-record")).toBe(true)
      expect(messageEvents).toHaveLength(1)
      expect(mappings.some((item) => item.runtimeRef === messageEvents[0]?.runtimeRef)).toBe(true)
    } finally {
      server.stop(true)
      await runtime.dispose()
    }
  })
})
