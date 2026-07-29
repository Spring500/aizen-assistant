import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("认证与模型", () => {
  test("API 密钥登录通过提示事件写入指定 auth.json", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-auth-"))
    directories.push(directory)
    const authPath = join(directory, "auth.json")
    const runtime = await PiSessionRuntime.create({ authPath, modelsPath: null })
    const prompts: Array<{ promptType: string }> = []
    runtime.subscribe((event) => {
      if (event.type === "auth_prompt") {
        prompts.push({ promptType: event.promptType })
        runtime.answerAuthPrompt(event.promptId, "secret-key")
      }
    })

    await runtime.loginApiKey("anthropic")
    expect(prompts).toEqual([{ promptType: "secret" }])
    expect(await readFile(authPath, "utf8")).toContain("secret-key")
    expect(JSON.stringify(await runtime.listAuthProviders())).not.toContain("secret-key")
    await runtime.dispose()
  })

  test("可取消正在等待的认证提示", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-auth-"))
    directories.push(directory)
    const runtime = await PiSessionRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null })
    runtime.subscribe((event) => {
      if (event.type === "auth_prompt") runtime.cancelAuth()
    })

    await expect(runtime.loginApiKey("anthropic")).rejects.toThrow("认证已取消")
    await runtime.dispose()
  })

  test("多步骤认证保留选择项并继续输入密钥", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-auth-"))
    directories.push(directory)
    const runtime = await PiSessionRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null })
    const prompts: Array<{ promptType: string; options?: string[] }> = []
    runtime.subscribe((event) => {
      if (event.type !== "auth_prompt") return
      prompts.push({
        promptType: event.promptType,
        ...(event.options ? { options: event.options.map((option) => option.id) } : {}),
      })
      runtime.answerAuthPrompt(event.promptId, event.promptType === "select" ? "bearer-token" : "secret-key")
    })

    await runtime.loginApiKey("amazon-bedrock")
    expect(prompts).toEqual([
      {
        promptType: "select",
        options: ["bearer-token", "aws-profile", "credential-chain"],
      },
      { promptType: "secret" },
    ])
    await runtime.dispose()
  })

  test("models.json 可增加第三方服务商和模型", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-auth-"))
    directories.push(directory)
    const modelsPath = join(directory, "models.json")
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          example: {
            name: "示例服务商",
            baseUrl: "https://api.example.com/v1",
            api: "openai-completions",
            models: [{ id: "example-model", name: "示例模型" }],
          },
        },
      }),
    )
    const runtime = await PiSessionRuntime.create({ authPath: join(directory, "auth.json"), modelsPath })

    expect(await runtime.listAuthProviders()).toContainEqual({
      id: "example",
      name: "示例服务商",
      configured: false,
      supportsApiKey: true,
    })
    expect(await runtime.listModels()).toContainEqual({
      providerId: "example",
      modelId: "example-model",
      api: "openai-completions",
      name: "示例模型",
      contextWindow: 128000,
      available: false,
    })
    await runtime.dispose()
  })

  test("第三方模型向用户暴露自身档位名和默认档位", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-auth-"))
    directories.push(directory)
    const modelsPath = join(directory, "models.json")
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          example: {
            name: "示例服务商",
            baseUrl: "https://api.example.com/v1",
            api: "openai-completions",
            models: [
              {
                id: "thinking-model",
                disableThinkingLevel: "关闭",
                thinkingLevels: ["A", "B", "C"],
                defaultThinkingLevel: "B",
              },
            ],
          },
        },
      }),
    )
    const runtime = await PiSessionRuntime.create({ authPath: join(directory, "auth.json"), modelsPath })

    expect((await runtime.listModels()).find((item) => item.modelId === "thinking-model")).toMatchObject({
      thinkingLevel: "B",
      thinkingLevels: ["A", "B", "C"],
      offThinkingLevel: "关闭",
    })
    await runtime.dispose()
  })

  test("发送请求时将Aizen档位转换为模型自身档位参数", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aizen-auth-"))
    directories.push(directory)
    const modelsPath = join(directory, "models.json")
    const requests: Array<Record<string, unknown>> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push((await request.json()) as Record<string, unknown>)
        const body = [
          `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "thinking-model", choices: [{ index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "thinking-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
          "data: [DONE]",
          "",
        ].join("\n\n")
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      },
    })
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          example: {
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            api: "openai-completions",
            models: [
              {
                id: "thinking-model",
                thinkingLevels: ["快速", "标准", "深入"],
                defaultThinkingLevel: "标准",
              },
            ],
          },
        },
      }),
    )
    const runtime = await PiSessionRuntime.create({ authPath: join(directory, "auth.json"), modelsPath })
    try {
      await runtime.setRuntimeApiKey("example", "test-key")
      await runtime.create({
        cwd: directory,
        model: {
          providerId: "example",
          modelId: "thinking-model",
          api: "openai-completions",
          thinkingLevel: "标准",
        },
        view: { viewId: null },
      })
      await runtime.prompt({
        recordId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        viewId: null,
        items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "测试" }] }],
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.reasoning_effort).toBe("标准")
    } finally {
      await runtime.dispose()
      server.stop(true)
    }
  })
})
