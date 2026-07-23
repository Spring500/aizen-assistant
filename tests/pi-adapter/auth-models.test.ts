import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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
})
