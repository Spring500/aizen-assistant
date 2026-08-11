import { afterEach, describe, expect } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import { AppPreferencesStore } from "../../packages/core/app-preferences-store.ts"
import { ModelConfigStore } from "../../packages/core/model-config-store.ts"
import {
  type PiCreateInput,
  PiModelRuntimeError,
  type PiPort,
  type PiPortEvent,
  type PiRestoreInput,
  type PiSessionTitleInput,
  type ResolvedViewResources,
} from "../../packages/core/pi-port.ts"
import type { ModelReference } from "../../packages/core/session-format.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import { SkillStore } from "../../packages/core/skill-store.ts"
import { writeViewConfig } from "../../packages/core/view-config.ts"
import { ViewStore } from "../../packages/core/view-store.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const model: ModelReference = { providerId: "test", modelId: "model", thinkingLevel: "off" }
const directories: string[] = []

class FakePi implements PiPort {
  listeners = new Set<(event: PiPortEvent) => void>()
  prompts: unknown[] = []
  create = async (_input: PiCreateInput) => model
  restore = async (_input: PiRestoreInput) => model
  refreshView = async () => {}
  switchView = async () => model
  generateSessionTitle = async (_input: PiSessionTitleInput) => "测试标题"
  compactInstructions: Array<string | undefined> = []
  compact = async (customInstructions?: string) => {
    this.compactInstructions.push(customInstructions)
  }
  abort = async () => {}
  listModels = async () => [{ ...model, name: "测试模型", available: true }]
  reloadModelConfig = async () => {}
  setModel = async (_model: ModelReference) => model
  listAuthProviders = async () => []
  loginApiKey = async () => {}
  answerAuthPrompt = () => {}
  cancelAuth = () => {}
  dispose = async () => {}
  subscribe(listener: (event: PiPortEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async prompt(input: unknown) {
    this.prompts.push(input)
    for (const listener of this.listeners) {
      listener({ type: "text_delta", delta: "完成" })
      listener({
        type: "message",
        recordId: crypto.randomUUID(),
        record: {
          role: "assistant",
          parts: [{ kind: "text", text: "完成" }],
          source: { providerId: "test", modelId: "model", api: "anthropic-messages" },
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      })
      listener({ type: "settled" })
    }
  }
}

class NamingFakePi extends FakePi {
  titleCalls: Array<{ firstUserMessage: string }> = []
  titleResult = "自动标题"
  titleError: Error | undefined
  titleDelay: Promise<void> | undefined

  override generateSessionTitle = async (input: PiSessionTitleInput) => {
    this.titleCalls.push({ firstUserMessage: input.firstUserMessage })
    await this.titleDelay
    if (this.titleError) throw this.titleError
    return this.titleResult
  }
}

async function configuredCore(root: string, pi: PiPort, store = new SessionStore(join(root, "sessions"))) {
  const preferencesStore = new AppPreferencesStore(join(root, "preferences.json"))
  await preferencesStore.write({
    newSession: { viewId: null, permissionMode: "hybrid" },
    agents: { sessionNaming: { model: { providerId: "test", modelId: "title-model" } }, permissionReview: {} },
    fold: { thinkingExpanded: false, toolGroupExpanded: false, toolDetailsExpanded: false },
  })
  const core = new AizenCore({ cwd: "E:\\project", store, pi, preferencesStore })
  await core.dispatch({ type: "load_preferences" })
  return { core, store }
}

class MessageFailingStore extends SessionStore {
  messageAttempts = 0

  override append(sessionId: string, record: Parameters<SessionStore["append"]>[1]): Promise<void> {
    if (record.kind === "message") {
      this.messageAttempts++
      return Promise.reject(new Error("磁盘不可写"))
    }
    return super.append(sessionId, record)
  }
}

class CreateFailingFakePi extends FakePi {
  create = async () => {
    throw new Error("无法创建运行时")
  }
}

class RecoverableModelFakePi extends FakePi {
  invalid = true
  restoreCalls: Array<{ model: ModelReference; recordCount: number }> = []

  override restore = async (input: PiRestoreInput) => {
    this.restoreCalls.push({ model: input.model, recordCount: input.records.length })
    if (this.invalid)
      throw new PiModelRuntimeError(`模型 ${input.model.providerId}/${input.model.modelId} 未配置思考档位`)
    return input.model
  }
}

class ReloadingModelFakePi extends FakePi {
  restoreCalls: PiRestoreInput[] = []
  override create = async (input: PiCreateInput) => input.model
  override restore = async (input: PiRestoreInput) => {
    this.restoreCalls.push(input)
    return input.model
  }
}

class DisposeFailingFakePi extends FakePi {
  abortCalls = 0
  disposeCalls = 0
  abort = async () => {
    this.abortCalls++
    throw new Error("中止失败")
  }
  dispose = async () => {
    this.disposeCalls++
    throw new Error("释放失败")
  }
  async prompt() {
    await new Promise(() => {})
  }
}

class TurnFinishedFailingStore extends SessionStore {
  override append(sessionId: string, record: Parameters<SessionStore["append"]>[1]): Promise<void> {
    if (record.kind === "turn_finished") return Promise.reject(new Error("轮次结尾不可写"))
    return super.append(sessionId, record)
  }
}

class SettingRecordFailingStore extends SessionStore {
  failKind: "model_changed" | "view_changed" | undefined

  override append(sessionId: string, record: Parameters<SessionStore["append"]>[1]): Promise<void> {
    if (record.kind === this.failKind) return Promise.reject(new Error("设置记录不可写"))
    return super.append(sessionId, record)
  }
}

class RuntimeStateFakePi extends FakePi {
  activeModel: ModelReference | undefined
  activeViewId: string | null | undefined

  override create = async (input: PiCreateInput) => {
    this.activeModel = input.model
    this.activeViewId = input.view.viewId
    return input.model
  }

  override restore = async (input: PiRestoreInput) => {
    this.activeModel = input.model
    this.activeViewId = input.view.viewId
    return input.model
  }

  override setModel = async (next: ModelReference) => {
    this.activeModel = next
    return next
  }
}

class CompactingFakePi extends FakePi {
  async prompt(input: { recordId: string }) {
    for (const listener of this.listeners) {
      listener({
        type: "message",
        recordId: "assistant-record",
        record: {
          role: "assistant",
          parts: [{ kind: "text", text: "完成" }],
          source: { providerId: "test", modelId: "model", api: "anthropic-messages" },
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      })
      listener({
        type: "compaction",
        summary: "摘要",
        firstKeptRecordId: "assistant-record",
        tokensBefore: 100,
      })
      listener({ type: "settled" })
    }
    this.prompts.push(input)
  }
}

class RecordingViewFakePi extends FakePi {
  views: ResolvedViewResources[] = []

  override create = async (input: PiCreateInput) => {
    this.views.push(input.view)
    return model
  }

  override restore = async (input: PiRestoreInput) => {
    this.views.push(input.view)
    return model
  }
}

class UsageFakePi extends FakePi {
  async prompt() {
    for (const listener of this.listeners) {
      listener({ type: "usage_updated", outputTokens: 0, contextTokens: 0 })
      listener({
        type: "message",
        recordId: crypto.randomUUID(),
        record: {
          role: "assistant",
          parts: [{ kind: "text", text: "完成" }],
          source: { providerId: "test", modelId: "model", api: "anthropic-messages" },
          stopReason: "stop",
          usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0 },
        },
      })
    }
  }
}

class ZeroUsageFakePi extends FakePi {
  async prompt() {
    for (const listener of this.listeners) {
      listener({ type: "usage_updated", outputTokens: 0 })
      listener({
        type: "message",
        recordId: crypto.randomUUID(),
        record: {
          role: "assistant",
          parts: [],
          source: { providerId: "test", modelId: "model", api: "anthropic-messages" },
          stopReason: "aborted",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      })
    }
  }
}

class FailingFakePi extends FakePi {
  async prompt() {
    for (const listener of this.listeners) {
      listener({
        type: "message",
        recordId: "failed-message",
        record: {
          role: "assistant",
          parts: [],
          source: { providerId: "test", modelId: "model", api: "anthropic-messages" },
          stopReason: "error",
          errorMessage: "服务不可用",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      })
      listener({ type: "settled" })
    }
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("核心编排", () => {
  test("创建会话前先读取已有偏好并只更新默认会话配置", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const preferencesStore = new AppPreferencesStore(join(root, "preferences.json"))
    await preferencesStore.write({
      newSession: { viewId: null, permissionMode: "hybrid" },
      agents: { sessionNaming: {}, permissionReview: {} },
      fold: { thinkingExpanded: true, toolGroupExpanded: false, toolDetailsExpanded: true },
    })
    const core = new AizenCore({
      cwd: "E:\\project",
      store: new SessionStore(join(root, "sessions")),
      pi: new FakePi(),
      preferencesStore,
    })

    expect(await core.dispatch({ type: "create_session", model, viewId: null })).toEqual({ ok: true })
    expect((await preferencesStore.read()).fold.thinkingExpanded).toBe(true)
    expect((await preferencesStore.read()).newSession.model).toEqual(model)
    await core.dispose()
  })

  test("偏好警告保留合法字段且不被后续命令清除", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const preferencesStore = new AppPreferencesStore(join(root, "preferences.json"))
    await writeFile(
      join(root, "preferences.json"),
      JSON.stringify({
        newSession: { viewId: "review", permissionMode: "invalid" },
        agents: { sessionNaming: {}, permissionReview: {} },
        fold: { thinkingExpanded: true, toolGroupExpanded: false, toolDetailsExpanded: false },
      }),
    )
    const core = new AizenCore({
      cwd: "E:\\project",
      store: new SessionStore(join(root, "sessions")),
      pi: new FakePi(),
      preferencesStore,
    })

    expect(await core.dispatch({ type: "load_preferences" })).toEqual({ ok: true })
    expect(core.getSnapshot().preferences.newSession.viewId).toBe("review")
    expect(core.getSnapshot().preferences.fold.thinkingExpanded).toBe(true)
    expect(core.getSnapshot().lastError).toContain("newSession.permissionMode 无效，已使用默认值")
    await core.dispatch({ type: "list_sessions" })
    expect(core.getSnapshot().lastError).toContain("newSession.permissionMode 无效，已使用默认值")
    await core.dispose()
  })

  test("模型配置变更重载运行时并保护当前模型", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const pi = new RuntimeStateFakePi()
    const config = new ModelConfigStore(join(root, "custom-providers.json"))
    const core = new AizenCore({
      cwd: "E:\\project",
      store: new SessionStore(join(root, "sessions")),
      pi,
      modelConfigStore: config,
    })

    await core.dispatch({ type: "load_model_config" })
    let revision = core.getSnapshot().modelConfig?.revision ?? ""
    expect(
      await core.dispatch({
        type: "save_provider",
        revision,
        provider: {
          id: "company",
          name: "公司网关",
          baseUrl: "https://example.com/v1",
          api: "openai-completions",
          authHeader: true,
        },
        create: true,
      }),
    ).toEqual({ ok: true })
    revision = core.getSnapshot().modelConfig?.revision ?? ""
    expect(
      await core.dispatch({
        type: "save_model",
        revision,
        providerId: "company",
        model: {
          id: "model-a",
          name: "模型 A",
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 16000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        create: true,
      }),
    ).toEqual({ ok: true })
    expect(core.getSnapshot().modelConfig?.providers[0]?.models[0]?.id).toBe("model-a")

    await core.dispatch({ type: "create_session", model, viewId: null })
    revision = core.getSnapshot().modelConfig?.revision ?? ""
    expect(await core.dispatch({ type: "delete_model", revision, providerId: "test", modelId: "model" })).toEqual({
      ok: false,
      error: { code: "COMMAND_FAILED", message: "不能删除当前会话正在使用的模型，请先切换模型", severity: "error" },
    })
    await core.dispose()
  })

  test("空闲时允许编辑当前模型并使用完整历史重新激活", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const pi = new ReloadingModelFakePi()
    const config = new ModelConfigStore(join(root, "custom-providers.json"))
    const core = new AizenCore({
      cwd: "E:\\project",
      store: new SessionStore(join(root, "sessions")),
      pi,
      modelConfigStore: config,
    })
    await core.dispatch({ type: "load_model_config" })
    let revision = core.getSnapshot().modelConfig?.revision ?? ""
    await core.dispatch({
      type: "save_provider",
      revision,
      provider: {
        id: "company",
        name: "公司网关",
        baseUrl: "https://example.com/v1",
        api: "openai-completions",
        authHeader: true,
      },
      create: true,
    })
    revision = core.getSnapshot().modelConfig?.revision ?? ""
    const editableModel = {
      id: "model-a",
      name: "模型 A",
      input: ["text" as const],
      contextWindow: 128000,
      maxTokens: 16000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    await core.dispatch({
      type: "save_model",
      revision,
      providerId: "company",
      model: editableModel,
      create: true,
    })
    const companyModel = { providerId: "company", modelId: "model-a", api: "openai-completions" }
    await core.dispatch({ type: "create_session", model: companyModel, viewId: null })
    await core.dispatch({ type: "send_prompt", text: "已有历史" })

    revision = core.getSnapshot().modelConfig?.revision ?? ""
    expect(
      await core.dispatch({
        type: "save_model",
        revision,
        providerId: "company",
        model: { ...editableModel, contextWindow: 256000 },
      }),
    ).toEqual({ ok: true })
    expect(core.getSnapshot().runtimeIssue).toBeUndefined()
    expect(pi.restoreCalls.at(-1)?.model).toEqual(companyModel)
    expect(JSON.stringify(pi.restoreCalls.at(-1)?.records)).toContain("已有历史")
    await core.dispose()
  })

  test("核心保留工具参数并更新流式输出预览", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const pi = new FakePi()
    const core = new AizenCore({ cwd: "E:\\project", store: new SessionStore(root), pi })

    for (const listener of pi.listeners) {
      listener({ type: "tool_started", callId: "c1", name: "bash", arguments: { command: "bun test" } })
      listener({ type: "tool_updated", callId: "c1", name: "bash", output: "第一行\n最后一行" })
    }

    expect(core.getSnapshot().activeTools).toEqual([
      {
        callId: "c1",
        name: "bash",
        arguments: { command: "bun test" },
        outputPreview: "第一行\n最后一行",
      },
    ])
    await core.dispose()
  })

  test("文本增量事件实时累积到流式输出快照", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    // 延迟版 FakePi：先发 text_delta，停留超过节流窗口后再完成轮次，
    // 确保流式中间快照能在窗口内到达订阅者。
    const pi = new (class extends FakePi {
      override async prompt(input: unknown): Promise<void> {
        this.prompts.push(input)
        for (const listener of this.listeners) listener({ type: "text_delta", delta: "完成" })
        await Bun.sleep(40)
        for (const listener of this.listeners) {
          listener({
            type: "message",
            recordId: crypto.randomUUID(),
            record: {
              role: "assistant",
              parts: [{ kind: "text", text: "完成" }],
              source: { providerId: "test", modelId: "model", api: "anthropic-messages" },
              stopReason: "stop",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          })
          listener({ type: "settled" })
        }
      }
    })()
    const core = new AizenCore({ cwd: "E:\\project", store: new SessionStore(root), pi })
    await core.dispatch({ type: "create_session", model, viewId: null })

    // 记录运行期间的流式文本快照；若快照缺失说明 text_delta 未被核心累积
    // （回归保护：删除处理即失败）
    const streamingValues: string[] = []
    let sawRunning = false
    core.subscribe((event) => {
      if (event.type !== "snapshot") return
      if (event.snapshot.status !== "running") return
      sawRunning = true
      streamingValues.push(event.snapshot.streamingText)
    })

    expect(await core.dispatch({ type: "send_prompt", text: "测试流式" })).toEqual({ ok: true })
    await Bun.sleep(30)
    expect(sawRunning).toBe(true)
    expect(streamingValues).toContain("完成")
    await core.dispose()
  })

  test("归档即清空：消息归档后流式字段清空，工具结果归档后从活动列表移除", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    // 挂起版 FakePi：turn 保持 running，测试内手动驱动事件序列。
    let releaseTurn!: () => void
    const turnGate = new Promise<void>((resolve) => (releaseTurn = resolve))
    const pi = new (class extends FakePi {
      override async prompt(input: unknown): Promise<void> {
        this.prompts.push(input)
        for (const listener of this.listeners) listener({ type: "text_delta", delta: "正在思考" })
        await turnGate
      }
    })()
    const core = new AizenCore({ cwd: "E:\\project", store: new SessionStore(root), pi })
    await core.dispatch({ type: "create_session", model, viewId: null })
    const sending = core.dispatch({ type: "send_prompt", text: "测试归档清空" })
    for (let attempt = 0; attempt < 50 && core.getSnapshot().status !== "running"; attempt++) await Bun.sleep(2)
    expect(core.getSnapshot().streamingText).toBe("正在思考")

    // 思考/文本段归档：assistant 消息到达 → 流式字段应清空。
    const assistantRecord = {
      role: "assistant" as const,
      parts: [{ kind: "text" as const, text: "正在思考" }],
      source: { providerId: "test", modelId: "model", api: "anthropic-messages" as const },
      stopReason: "stop" as const,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    }
    for (const listener of pi.listeners) {
      listener({ type: "message", recordId: crypto.randomUUID(), record: assistantRecord })
    }
    expect(core.getSnapshot().streamingText).toBe("")
    expect(core.getSnapshot().streamingThinking).toBe("")
    expect(
      core.getSnapshot().transcript.some((entry) => entry.type === "message" && entry.message.role === "assistant"),
    ).toBe(true)

    // 工具执行与结果归档：工具结果消息到达 → 从活动列表移除。
    for (const listener of pi.listeners) {
      listener({ type: "tool_started", callId: "archived-call", name: "bash", arguments: { command: "ls" } })
    }
    expect(core.getSnapshot().activeTools).toHaveLength(1)
    for (const listener of pi.listeners) {
      listener({
        type: "message",
        recordId: crypto.randomUUID(),
        record: {
          role: "tool" as const,
          callId: "archived-call",
          name: "bash",
          isError: false,
          parts: [{ kind: "text" as const, text: "完成" }],
        },
      })
    }
    expect(core.getSnapshot().activeTools).toHaveLength(0)

    releaseTurn()
    expect(await sending).toEqual({ ok: true })
    await core.dispose()
  })

  test("认证选择事件保留候选项", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const pi = new FakePi()
    const core = new AizenCore({ cwd: "E:\\project", store: new SessionStore(root), pi })
    const events: unknown[] = []
    core.subscribe((event) => events.push(event))

    for (const listener of pi.listeners) {
      listener({
        type: "auth_prompt",
        promptId: "prompt",
        promptType: "select",
        message: "选择认证方式",
        options: [{ id: "token", label: "令牌" }],
      })
    }

    expect(events).toContainEqual({
      type: "auth_prompt",
      promptId: "prompt",
      promptType: "select",
      message: "选择认证方式",
      options: [{ id: "token", label: "令牌" }],
    })
    await core.dispose()
  })

  test("新建会话使用助记词 ID，且重命名允许清空并持久化", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const core = new AizenCore({ cwd: "E:\\project", store, pi: new FakePi() })
    const created = await core.dispatch({ type: "create_session", model, viewId: null })
    expect(created.ok).toBe(true)
    const sessionId = core.getSnapshot().currentSessionId
    expect(sessionId).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/)
    if (!sessionId) throw new Error("新建会话后缺少会话 ID")

    expect((await core.dispatch({ type: "rename_session", sessionId, name: "  需求讨论  " })).ok).toBe(true)
    expect(core.getSnapshot().currentSessionName).toBe("需求讨论")
    expect((await store.list())[0]?.name).toBe("需求讨论")

    expect((await core.dispatch({ type: "rename_session", sessionId, name: "   " })).ok).toBe(true)
    expect(core.getSnapshot().currentSessionName).toBe("")
    expect((await store.list())[0]?.name).toBe("")
    await core.dispose()
  })

  test("配置命名模型后异步使用第一条消息且每次加载只尝试一次", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const pi = new NamingFakePi()
    const { core, store } = await configuredCore(root, pi)
    await core.dispatch({ type: "create_session", model, viewId: null })
    const sessionId = core.getSnapshot().currentSessionId ?? ""
    await core.dispatch({ type: "send_prompt", text: "第一条用户消息" })
    await core.dispatch({ type: "send_prompt", text: "第二条用户消息" })
    expect(pi.titleCalls).toEqual([{ firstUserMessage: "第一条用户消息" }])
    expect(core.getSnapshot().currentSessionName).toBe("自动标题")
    expect((await store.read(sessionId)).records.filter((record) => record.kind === "session_renamed")).toHaveLength(1)

    const restoredPi = new NamingFakePi()
    const restored = (await configuredCore(root, restoredPi, store)).core
    await restored.dispatch({ type: "open_session", sessionId })
    await restored.dispatch({ type: "send_prompt", text: "第三条用户消息" })
    expect(restoredPi.titleCalls).toHaveLength(0)
    await core.dispose()
    await restored.dispose()
  })

  test("未配置模型不消耗本次加载的命名机会", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const pi = new NamingFakePi()
    const preferencesStore = new AppPreferencesStore(join(root, "preferences.json"))
    const core = new AizenCore({
      cwd: "E:\\project",
      store: new SessionStore(join(root, "sessions")),
      pi,
      preferencesStore,
    })
    await core.dispatch({ type: "create_session", model, viewId: null })
    await core.dispatch({ type: "send_prompt", text: "第一条" })
    expect(pi.titleCalls).toHaveLength(0)
    await core.dispatch({
      type: "save_agent_preferences",
      agents: { sessionNaming: { model: { providerId: "test", modelId: "title-model" } }, permissionReview: {} },
    })
    await core.dispatch({ type: "send_prompt", text: "第二条" })
    expect(pi.titleCalls).toEqual([{ firstUserMessage: "第一条" }])
    await core.dispose()
  })

  test("命名失败本次加载不重试，重新打开后恢复一次机会", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const pi = new NamingFakePi()
    pi.titleError = new Error("网络波动")
    const { core, store } = await configuredCore(root, pi)
    await core.dispatch({ type: "create_session", model, viewId: null })
    const sessionId = core.getSnapshot().currentSessionId ?? ""
    await core.dispatch({ type: "send_prompt", text: "第一条" })
    for (let attempt = 0; attempt < 20 && !core.getSnapshot().lastError; attempt++) await Bun.sleep(5)
    expect(core.getSnapshot().lastError).toBe("会话自动命名失败：网络波动")
    await core.dispatch({ type: "send_prompt", text: "第二条" })
    expect(pi.titleCalls).toHaveLength(1)

    const restoredPi = new NamingFakePi()
    const restored = (await configuredCore(root, restoredPi, store)).core
    await restored.dispatch({ type: "open_session", sessionId })
    await restored.dispatch({ type: "send_prompt", text: "重新加载后的请求" })
    expect(restoredPi.titleCalls).toEqual([{ firstUserMessage: "第一条" }])
    for (let attempt = 0; attempt < 20 && !restored.getSnapshot().currentSessionName; attempt++) await Bun.sleep(5)
    expect(restored.getSnapshot().currentSessionName).toBe("自动标题")
    await core.dispose()
    await restored.dispose()
  })

  test("回退不重置本次加载的命名机会", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const pi = new NamingFakePi()
    pi.titleError = new Error("命名失败")
    const { core } = await configuredCore(root, pi)
    await core.dispatch({ type: "create_session", model, viewId: null })
    await core.dispatch({ type: "send_prompt", text: "第一条" })
    for (let attempt = 0; attempt < 20 && !core.getSnapshot().lastError; attempt++) await Bun.sleep(5)
    const turn = core.getSnapshot().transcript.find((entry) => entry.type === "input")
    if (!turn) throw new Error("缺少回退轮次")
    await core.dispatch({ type: "rewind", turnId: turn.turnId })
    await core.dispatch({ type: "send_prompt", text: "回退后的消息" })
    expect(pi.titleCalls).toHaveLength(1)
    await core.dispose()
  })

  test("后台命名不阻塞主请求且不会覆盖手动名称", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    let release = () => {}
    const pi = new NamingFakePi()
    pi.titleDelay = new Promise<void>((resolve) => {
      release = resolve
    })
    const { core } = await configuredCore(root, pi)
    await core.dispatch({ type: "create_session", model, viewId: null })
    const sessionId = core.getSnapshot().currentSessionId ?? ""
    expect(await core.dispatch({ type: "send_prompt", text: "第一条" })).toEqual({ ok: true })
    expect(core.getSnapshot().currentSessionName).toBe("")
    await core.dispatch({ type: "rename_session", sessionId, name: "手动名称" })
    release()
    for (let attempt = 0; attempt < 20 && pi.titleCalls.length === 0; attempt++) await Bun.sleep(5)
    await Bun.sleep(5)
    expect(core.getSnapshot().currentSessionName).toBe("手动名称")
    await core.dispose()
  })

  test("运行时创建失败时不留下空会话", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const core = new AizenCore({ cwd: "E:\\project", store, pi: new CreateFailingFakePi() })

    expect(await core.dispatch({ type: "create_session", model, viewId: null })).toEqual({
      ok: false,
      error: { code: "COMMAND_FAILED", message: "无法创建运行时", severity: "error" },
    })
    expect(core.getSnapshot().currentSessionId).toBeUndefined()
    expect(await store.list()).toEqual([])
    await core.dispose()
  })

  test("配置视图存储时仍可创建和恢复无视图会话", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(join(root, "sessions"))
    const pi = new FakePi()
    const core = new AizenCore({
      cwd: "E:\\project",
      store,
      pi,
      views: new ViewStore(join(root, "views.json")),
    })

    expect(await core.dispatch({ type: "create_session", model, viewId: null })).toEqual({ ok: true })
    const sessionId = core.getSnapshot().currentSessionId ?? ""
    expect(core.getSnapshot().currentViewId).toBeNull()
    await core.dispose()

    const restored = new AizenCore({
      cwd: "E:\\project",
      store,
      pi: new FakePi(),
      views: new ViewStore(join(root, "views.json")),
    })
    expect(await restored.dispatch({ type: "open_session", sessionId })).toEqual({ ok: true })
    expect(restored.getSnapshot().currentViewId).toBeNull()
    await restored.dispose()
  })

  test("第二个核心不能打开已占用会话", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-lock-"))
    directories.push(root)
    const store = new SessionStore(root)
    const first = new AizenCore({ cwd: "E:\\project", store, pi: new FakePi() })
    await first.dispatch({ type: "create_session", model, viewId: null })
    const sessionId = first.getSnapshot().currentSessionId
    if (!sessionId) throw new Error("缺少会话 ID")

    const second = new AizenCore({ cwd: "E:\\project", store: new SessionStore(root), pi: new FakePi() })
    expect(await second.dispatch({ type: "open_session", sessionId })).toEqual({
      ok: false,
      error: { code: "SESSION_LOCKED", message: `会话正在被其他 Agent 使用：${sessionId}`, severity: "error" },
    })
    expect(second.getSnapshot().currentSessionId).toBeUndefined()
    await first.dispose()
    await second.dispose()
  })

  test("目录变化时记录提示并正常打开和重命名", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const original = new AizenCore({ cwd: "E:\\project", store, pi: new FakePi() })
    await original.dispatch({ type: "create_session", model, viewId: null })
    const sessionId = original.getSnapshot().currentSessionId ?? ""
    await original.dispatch({ type: "send_prompt", text: "第一轮" })
    await original.dispose()

    const movedPi = new ReloadingModelFakePi()
    const moved = new AizenCore({ cwd: "D:\\project", store, pi: movedPi })
    expect(await moved.dispatch({ type: "open_session", sessionId })).toEqual({ ok: true })
    expect(await moved.dispatch({ type: "rename_session", sessionId, name: "迁移会话" })).toEqual({ ok: true })
    const loaded = await store.read(sessionId)
    expect(loaded.records.filter((record) => record.kind === "working_directory_changed")).toEqual([
      expect.objectContaining({ previousCwd: "E:\\project", currentCwd: "D:\\project" }),
    ])
    expect(movedPi.restoreCalls.at(-1)?.records).toContainEqual(
      expect.objectContaining({
        kind: "working_directory_changed",
        previousCwd: "E:\\project",
        currentCwd: "D:\\project",
      }),
    )
    expect(moved.getSnapshot().transcript).toContainEqual(
      expect.objectContaining({
        type: "environment",
        text: 'Working directory changed from "E:\\project" to "D:\\project".',
      }),
    )
    await moved.dispose()
  })

  test("规范化后相同的目录不产生变更记录", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    await store.createWithRecords(
      {
        sessionId: "same-path",
        cwd: "E:\\Project\\AizenAssistant\\",
        createdAt: "2026-07-23T10:00:00.000Z",
      },
      [
        { kind: "model_changed", recordId: "model", at: "2026-07-23T10:00:00.000Z", model },
        { kind: "view_changed", recordId: "view", at: "2026-07-23T10:00:00.000Z", viewId: null },
      ],
    )
    const core = new AizenCore({ cwd: "e:/project/aizenassistant", store, pi: new FakePi() })
    expect(await core.dispatch({ type: "open_session", sessionId: "same-path" })).toEqual({ ok: true })
    expect((await store.read("same-path")).records.some((record) => record.kind === "working_directory_changed")).toBe(
      false,
    )
    await core.dispose()
  })

  test("新建、发送多轮并从文件恢复", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const pi = new FakePi()
    const core = new AizenCore({ cwd: "E:\\project", store, pi })

    expect(await core.dispatch({ type: "create_session", model, viewId: null })).toEqual({ ok: true })
    const sessionId = core.getSnapshot().currentSessionId
    expect(sessionId).toBeDefined()
    expect(await core.dispatch({ type: "send_prompt", text: "第一轮" })).toEqual({ ok: true })
    expect(await core.dispatch({ type: "send_prompt", text: "第二轮" })).toEqual({ ok: true })
    expect(pi.prompts).toHaveLength(2)
    await core.dispose()

    const restoredPi = new FakePi()
    const restored = new AizenCore({ cwd: "E:\\project", store, pi: restoredPi })
    expect(await restored.dispatch({ type: "open_session", sessionId: sessionId ?? "" })).toEqual({ ok: true })
    expect(restored.getSnapshot().transcript.filter((entry) => entry.type === "turn_end")).toHaveLength(2)
    await restored.dispose()
  })

  test("模型配置失效时仍可打开和回退，重新选模型后继续发送", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const original = new AizenCore({ cwd: "E:\\project", store, pi: new FakePi() })
    await original.dispatch({ type: "create_session", model, viewId: null })
    const sessionId = original.getSnapshot().currentSessionId ?? ""
    await original.dispatch({ type: "send_prompt", text: "第一轮" })
    await original.dispatch({ type: "send_prompt", text: "第二轮" })
    await original.dispose()

    const pi = new RecoverableModelFakePi()
    const core = new AizenCore({ cwd: "E:\\project", store, pi })
    expect(await core.dispatch({ type: "open_session", sessionId })).toEqual({ ok: true })
    expect(core.getSnapshot().runtimeIssue).toEqual({
      kind: "model",
      message: "模型 test/model 未配置思考档位",
    })
    expect(JSON.stringify(core.getSnapshot().transcript)).toContain("第二轮")

    const recordsBeforeSend = (await store.read(sessionId)).records.length
    expect(await core.dispatch({ type: "send_prompt", text: "不能丢失的草稿" })).toEqual({
      ok: false,
      error: {
        code: "MODEL_SELECTION_REQUIRED",
        message: "模型 test/model 未配置思考档位",
        severity: "error",
      },
    })
    expect((await store.read(sessionId)).records).toHaveLength(recordsBeforeSend)

    const secondTurn = core
      .getSnapshot()
      .transcript.find(
        (entry) => entry.type === "input" && entry.items.some((item) => JSON.stringify(item).includes("第二轮")),
      )
    if (secondTurn?.type !== "input") throw new Error("缺少第二轮")
    expect(await core.dispatch({ type: "rewind", turnId: secondTurn.turnId })).toEqual({ ok: true })
    expect(JSON.stringify((await store.read(sessionId)).records)).not.toContain("第二轮")
    expect(core.getSnapshot().runtimeIssue?.kind).toBe("model")

    pi.invalid = false
    const replacement = { ...model, modelId: "replacement", thinkingLevel: "high" }
    expect(await core.dispatch({ type: "set_model", model: replacement })).toEqual({ ok: true })
    expect(core.getSnapshot().runtimeIssue).toBeUndefined()
    expect(pi.restoreCalls.at(-1)).toMatchObject({ model: replacement })
    expect(await core.dispatch({ type: "send_prompt", text: "修复后发送" })).toEqual({ ok: true })
    expect(JSON.stringify((await store.read(sessionId)).records)).toContain("修复后发送")
    await core.dispose()
  })

  test("模型或视图记录写入失败时恢复磁盘对应的运行设置", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SettingRecordFailingStore(root)
    const pi = new RuntimeStateFakePi()
    const core = new AizenCore({ cwd: "E:\\project", store, pi })
    await core.dispatch({ type: "create_session", model, viewId: null })
    const sessionId = core.getSnapshot().currentSessionId ?? ""

    store.failKind = "model_changed"
    const replacement = { ...model, modelId: "replacement", thinkingLevel: "high" }
    expect(await core.dispatch({ type: "set_model", model: replacement })).toEqual({
      ok: false,
      error: { code: "COMMAND_FAILED", message: "设置记录不可写", severity: "error" },
    })
    expect(core.getSnapshot().currentModel).toMatchObject(model)
    expect(pi.activeModel).toEqual(model)

    store.failKind = "view_changed"
    expect(await core.dispatch({ type: "set_view", viewId: "other-view" })).toEqual({
      ok: false,
      error: { code: "COMMAND_FAILED", message: "设置记录不可写", severity: "error" },
    })
    expect(core.getSnapshot().currentViewId).toBeNull()
    expect(pi.activeViewId).toBeNull()
    expect((await store.read(sessionId)).records.filter((record) => record.kind === "model_changed")).toHaveLength(1)
    expect((await store.read(sessionId)).records.filter((record) => record.kind === "view_changed")).toHaveLength(1)
    await core.dispose()
  })

  test("回退删除所选轮次及之后内容并保留当前设置", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const pi = new RuntimeStateFakePi()
    const core = new AizenCore({ cwd: "E:\\project", store, pi })

    await core.dispatch({ type: "create_session", model, viewId: null })
    const sessionId = core.getSnapshot().currentSessionId ?? ""
    await core.dispatch({ type: "rename_session", sessionId, name: "需求讨论" })
    await core.dispatch({ type: "send_prompt", text: "第一轮" })
    const replacement = { ...model, modelId: "replacement", thinkingLevel: "high" }
    await core.dispatch({ type: "set_model", model: replacement })
    await core.dispatch({ type: "send_prompt", text: "第二轮" })
    const secondTurn = core
      .getSnapshot()
      .transcript.find(
        (entry) => entry.type === "input" && entry.items.some((item) => JSON.stringify(item).includes("第二轮")),
      )
    if (secondTurn?.type !== "input") throw new Error("缺少第二轮")

    expect(await core.dispatch({ type: "rewind", turnId: secondTurn.turnId })).toEqual({ ok: true })
    const loaded = await store.read(sessionId)
    expect(JSON.stringify(loaded.records)).toContain("第一轮")
    expect(JSON.stringify(loaded.records)).not.toContain("第二轮")
    expect(core.getSnapshot().currentSessionName).toBe("需求讨论")
    // rewind 只删除对话记录，用户执行回退时正在使用的模型会继续用于下一轮。
    expect(core.getSnapshot().currentModel).toMatchObject(replacement)
    expect(core.getSnapshot().currentViewId).toBeNull()
    await core.dispose()

    const reopened = new AizenCore({ cwd: "E:\\project", store, pi: new RuntimeStateFakePi() })
    expect(await reopened.dispatch({ type: "open_session", sessionId })).toEqual({ ok: true })
    expect(JSON.stringify(reopened.getSnapshot().transcript)).not.toContain("第二轮")
    expect(reopened.getSnapshot().currentSessionName).toBe("需求讨论")
    expect(reopened.getSnapshot().currentModel).toMatchObject(replacement)
    await reopened.dispose()
  })

  test("回退跨越目录变化时保留当前目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const first = new AizenCore({ cwd: "A", store, pi: new FakePi() })
    await first.dispatch({ type: "create_session", model, viewId: null })
    const sessionId = first.getSnapshot().currentSessionId ?? ""
    await first.dispatch({ type: "send_prompt", text: "第一轮" })
    await first.dispose()

    const second = new AizenCore({ cwd: "B", store, pi: new FakePi() })
    await second.dispatch({ type: "open_session", sessionId })
    await second.dispatch({ type: "send_prompt", text: "第二轮" })
    await second.dispose()

    const current = new AizenCore({ cwd: "C", store, pi: new FakePi() })
    await current.dispatch({ type: "open_session", sessionId })
    await current.dispatch({ type: "send_prompt", text: "第三轮" })
    const firstTurn = current
      .getSnapshot()
      .transcript.find(
        (entry) => entry.type === "input" && entry.items.some((item) => JSON.stringify(item).includes("第一轮")),
      )
    if (firstTurn?.type !== "input") throw new Error("缺少第一轮")

    expect(await current.dispatch({ type: "rewind", turnId: firstTurn.turnId })).toEqual({ ok: true })
    const changes = (await store.read(sessionId)).records.filter(
      (record) => record.kind === "working_directory_changed",
    )
    expect(changes).toEqual([expect.objectContaining({ previousCwd: "A", currentCwd: "C" })])
    expect(JSON.stringify((await store.read(sessionId)).records)).not.toContain("第二轮")
    expect(JSON.stringify((await store.read(sessionId)).records)).not.toContain("第三轮")
    await current.dispose()
  })

  test("分支跨越目录变化时继承当前目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const original = new AizenCore({ cwd: "A", store, pi: new FakePi() })
    await original.dispatch({ type: "create_session", model, viewId: null })
    const sourceId = original.getSnapshot().currentSessionId ?? ""
    await original.dispatch({ type: "send_prompt", text: "第一轮" })
    await original.dispatch({ type: "send_prompt", text: "第二轮" })
    await original.dispose()

    const moved = new AizenCore({ cwd: "C", store, pi: new FakePi() })
    await moved.dispatch({ type: "open_session", sessionId: sourceId })
    const secondTurn = moved
      .getSnapshot()
      .transcript.find(
        (entry) => entry.type === "input" && entry.items.some((item) => JSON.stringify(item).includes("第二轮")),
      )
    if (secondTurn?.type !== "input") throw new Error("缺少第二轮")
    expect(await moved.dispatch({ type: "fork_session", turnId: secondTurn.turnId })).toEqual({ ok: true })
    const forkId = moved.getSnapshot().currentSessionId ?? ""
    expect((await store.read(forkId)).records.filter((record) => record.kind === "working_directory_changed")).toEqual([
      expect.objectContaining({ previousCwd: "A", currentCwd: "C" }),
    ])
    await moved.dispose()

    const reopened = new AizenCore({ cwd: "C", store, pi: new FakePi() })
    await reopened.dispatch({ type: "open_session", sessionId: forkId })
    const firstTurn = reopened.getSnapshot().transcript.find((entry) => entry.type === "input")
    if (firstTurn?.type !== "input") throw new Error("缺少第一轮")
    expect(await reopened.dispatch({ type: "rewind", turnId: firstTurn.turnId })).toEqual({ ok: true })
    expect((await store.read(forkId)).records.filter((record) => record.kind === "working_directory_changed")).toEqual([
      expect.objectContaining({ previousCwd: "A", currentCwd: "C" }),
    ])
    await reopened.dispose()
  })

  test("分支生成新会话并使用源名称副本", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const core = new AizenCore({ cwd: "E:\\project", store, pi: new FakePi() })

    await core.dispatch({ type: "create_session", model, viewId: null })
    const sourceId = core.getSnapshot().currentSessionId ?? ""
    await core.dispatch({ type: "rename_session", sessionId: sourceId, name: "需求讨论" })
    await core.dispatch({ type: "send_prompt", text: "第一轮" })
    await core.dispatch({ type: "send_prompt", text: "第二轮" })
    const secondTurn = core
      .getSnapshot()
      .transcript.find(
        (entry) => entry.type === "input" && entry.items.some((item) => JSON.stringify(item).includes("第二轮")),
      )
    if (secondTurn?.type !== "input") throw new Error("缺少第二轮")

    expect(await core.dispatch({ type: "fork_session", turnId: secondTurn.turnId })).toEqual({ ok: true })
    const forkId = core.getSnapshot().currentSessionId ?? ""
    expect(forkId).not.toBe(sourceId)
    expect(core.getSnapshot().currentSessionName).toBe("需求讨论_副本")
    expect(JSON.stringify((await store.read(sourceId)).records)).toContain("第二轮")
    expect(JSON.stringify((await store.read(forkId)).records)).not.toContain("第二轮")
    expect((await store.list()).map((session) => session.sessionId)).toContainAllValues([sourceId, forkId])
    await core.dispose()

    const reopened = new AizenCore({ cwd: "E:\\project", store, pi: new FakePi() })
    expect(await reopened.dispatch({ type: "open_session", sessionId: forkId })).toEqual({ ok: true })
    expect(reopened.getSnapshot().currentSessionName).toBe("需求讨论_副本")
    expect(JSON.stringify(reopened.getSnapshot().transcript)).not.toContain("第二轮")
    await reopened.dispose()
  })

  test("未命名会话分支使用源会话 ID 命名", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const core = new AizenCore({ cwd: "E:\\project", store: new SessionStore(root), pi: new FakePi() })
    await core.dispatch({ type: "create_session", model, viewId: null })
    const sourceId = core.getSnapshot().currentSessionId ?? ""
    await core.dispatch({ type: "send_prompt", text: "问题" })
    const turn = core.getSnapshot().transcript.find((entry) => entry.type === "input")
    if (!turn) throw new Error("缺少轮次")
    await core.dispatch({ type: "fork_session", turnId: turn.turnId })
    expect(core.getSnapshot().currentSessionName).toBe(`${sourceId}_副本`)
    await core.dispose()
  })

  test("额外消息先写入会话且 useLater 语义交给适配器", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const pi = new FakePi()
    const core = new AizenCore({
      cwd: "E:\\project",
      store,
      pi,
      extraMessages: async () => [
        {
          source: "clock",
          role: "developer",
          useLater: false,
          parts: [{ kind: "text", text: "仅本轮" }],
        },
      ],
    })

    await core.dispatch({ type: "create_session", model, viewId: null })
    const sessionId = core.getSnapshot().currentSessionId ?? ""
    await core.dispatch({ type: "send_prompt", text: "用户消息" })
    const loaded = await store.read(sessionId)
    const started = loaded.records.find((record) => record.kind === "turn_started")
    expect(started?.kind === "turn_started" ? started.items : []).toEqual([
      { source: "clock", role: "developer", useLater: false, parts: [{ kind: "text", text: "仅本轮" }] },
      { source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "用户消息" }] },
    ])
    expect(pi.prompts[0]).toMatchObject({ items: started?.kind === "turn_started" ? started.items : [] })
    await core.dispose()
  })

  test("首次回复前显示零，未确认和最终零用量不覆盖有效上下文", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(join(root, "sessions"))
    const pi = new UsageFakePi()
    const core = new AizenCore({ cwd: "E:\\project", store, pi })

    await core.dispatch({ type: "create_session", model, viewId: null })
    expect(core.getSnapshot().contextUsage?.used).toBe(0)
    await core.dispatch({ type: "send_prompt", text: "第一轮" })
    expect(core.getSnapshot().contextUsage?.used).toBe(15)

    const zeroPi = new ZeroUsageFakePi()
    const restored = new AizenCore({ cwd: "E:\\project", store, pi: zeroPi })
    const sessionId = core.getSnapshot().currentSessionId
    if (!sessionId) throw new Error("缺少会话 ID")
    await restored.dispatch({ type: "open_session", sessionId })
    await restored.dispatch({ type: "send_prompt", text: "第二轮" })
    expect(restored.getSnapshot().contextUsage?.used).toBe(15)
    await core.dispose()
    await restored.dispose()
  })

  test("手动压缩不创建轮次并等待压缩记录落盘", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const pi = new FakePi()
    const core = new AizenCore({ cwd: "E:\\project", store, pi })

    await core.dispatch({ type: "create_session", model, viewId: null })
    const sessionId = core.getSnapshot().currentSessionId ?? ""
    pi.compact = async (customInstructions?: string) => {
      pi.compactInstructions.push(customInstructions)
      for (const listener of pi.listeners)
        listener({ type: "compaction", summary: "摘要", firstKeptRecordId: "first", tokensBefore: 120000 })
    }
    expect(await core.dispatch({ type: "compact", customInstructions: "保留决策" })).toEqual({ ok: true })
    const loaded = await store.read(sessionId)
    expect(pi.compactInstructions).toEqual(["保留决策"])
    expect(loaded.records.filter((record) => record.kind === "turn_started")).toHaveLength(0)
    expect(loaded.records).toContainEqual(
      expect.objectContaining({
        kind: "compaction",
        summary: "摘要",
        firstKeptRecordId: "first",
        tokensBefore: 120000,
      }),
    )
    await core.dispose()
  })

  test("上下文压缩只保存核心记录 ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const core = new AizenCore({ cwd: "E:\\project", store, pi: new CompactingFakePi() })

    await core.dispatch({ type: "create_session", model, viewId: null })
    const sessionId = core.getSnapshot().currentSessionId ?? ""
    await core.dispatch({ type: "send_prompt", text: "触发压缩" })
    await core.dispose()

    const loaded = await store.read(sessionId)
    const message = loaded.records.find((record) => record.kind === "message")
    const compaction = loaded.records.find((record) => record.kind === "compaction")
    expect(message?.kind).toBe("message")
    expect(compaction?.kind).toBe("compaction")
    if (message?.kind === "message" && compaction?.kind === "compaction") {
      expect(compaction.firstKeptRecordId).toBe(message.recordId)
      expect(JSON.stringify(compaction)).not.toContain("pi-message-id")
    }
  })

  test("消息落盘失败会上报错误、阻止后续轮次且不影响释放", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new MessageFailingStore(root)
    const pi = new FakePi()
    const core = new AizenCore({ cwd: "E:\\project", store, pi })

    expect(await core.dispatch({ type: "create_session", model, viewId: null })).toEqual({ ok: true })
    expect(await core.dispatch({ type: "send_prompt", text: "触发失败" })).toEqual({
      ok: false,
      error: { code: "COMMAND_FAILED", message: "磁盘不可写", severity: "error" },
    })
    expect(store.messageAttempts).toBe(1)
    expect(core.getSnapshot().lastError).toBe("磁盘不可写")
    expect((await core.dispatch({ type: "send_prompt", text: "不应继续" })).ok).toBe(false)
    expect(store.messageAttempts).toBe(1)
    await expect(core.dispose()).resolves.toBeUndefined()
  })

  test("轮次结尾写入失败后阻止继续发送", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const core = new AizenCore({ cwd: "E:\\project", store: new TurnFinishedFailingStore(root), pi: new FakePi() })

    await core.dispatch({ type: "create_session", model, viewId: null })
    expect((await core.dispatch({ type: "send_prompt", text: "触发失败" })).ok).toBe(false)
    expect(core.getSnapshot().lastError).toBe("轮次结尾不可写")
    expect((await core.dispatch({ type: "send_prompt", text: "不应继续" })).ok).toBe(false)
    await core.dispose()
  })

  test("中止失败后仍释放订阅和运行时", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const pi = new DisposeFailingFakePi()
    const core = new AizenCore({ cwd: "E:\\project", store: new SessionStore(root), pi })
    await core.dispatch({ type: "create_session", model, viewId: null })
    void core.dispatch({ type: "send_prompt", text: "持续运行" })
    for (let attempt = 0; attempt < 20 && core.getSnapshot().status !== "running"; attempt++) await Bun.sleep(5)
    expect(core.getSnapshot().status).toBe("running")

    await expect(core.dispose()).rejects.toThrow("中止失败")
    expect(pi.abortCalls).toBe(1)
    expect(pi.disposeCalls).toBe(1)
    expect(pi.listeners.size).toBe(0)
  })

  test("模型错误写入失败轮次并恢复空闲", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const store = new SessionStore(root)
    const core = new AizenCore({ cwd: "E:\\project", store, pi: new FailingFakePi() })

    await core.dispatch({ type: "create_session", model, viewId: null })
    const sessionId = core.getSnapshot().currentSessionId ?? ""
    expect((await core.dispatch({ type: "send_prompt", text: "失败请求" })).ok).toBe(true)
    const loaded = await store.read(sessionId)
    const finished = loaded.records.find((record) => record.kind === "turn_finished")
    expect(finished).toMatchObject({ kind: "turn_finished", outcome: "failed" })
    expect(finished?.kind === "turn_finished" ? finished.error?.message : undefined).toBe("服务不可用")
    expect(core.getSnapshot().status).toBe("idle")
    await core.dispose()
  })
})

describe("视图装载资源组装", () => {
  const model: ModelReference = {
    providerId: "test",
    modelId: "model",
    thinkingLevel: "off",
  }

  /** 把固定仓库结构写到缓存目录的替身拉取，供用户层技能使用。 */
  async function userSkillStore(root: string): Promise<SkillStore> {
    const cacheDirectory = join(root, "user-cache")
    const store = new SkillStore({
      file: join(root, "skills.json"),
      cacheDirectory,
      fetchRepo: async (cacheDir: string) => {
        await mkdir(join(cacheDir, "user", "userskill"), { recursive: true })
        await writeFile(
          join(cacheDir, "user", "userskill", "SKILL.md"),
          "---\nname: userskill\ndescription: 用户技能\n---\n",
        )
      },
    })
    await store.discoverSource("https://example.com/skills.git")
    await store.installSkill({
      name: "userskill",
      sourceUrl: "https://example.com/skills.git",
      relPath: "user/userskill",
    })
    return store
  }

  test("无视图原生模式加载项目上下文与用户层技能", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const cwd = join(root, "project")
    await mkdir(join(cwd, ".agents", "skills", "projskill"), { recursive: true })
    await writeFile(join(cwd, "AGENTS.md"), "项目规则")
    await writeFile(
      join(cwd, ".agents", "skills", "projskill", "SKILL.md"),
      "---\nname: projskill\ndescription: 项目技能\n---\n",
    )
    const pi = new RecordingViewFakePi()
    const core = new AizenCore({
      cwd,
      store: new SessionStore(join(root, "sessions")),
      pi,
      skills: await userSkillStore(root),
    })

    expect(await core.dispatch({ type: "create_session", model, viewId: null })).toEqual({ ok: true })
    const view = pi.views.at(-1)
    expect(view?.viewId).toBeNull()
    expect(view?.agentsFiles.map((file) => file.content)).toEqual(["项目规则"])
    expect(view?.skillPaths.some((path) => path.replaceAll("\\", "/").includes(".agents/skills"))).toBe(true)
    expect(view?.skillPaths.some((path) => path.endsWith("userskill"))).toBe(true)
    await core.dispose()
  })

  test("视图按 projectSources 加载项目层，AGENTS.md 拼接在视图之后", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const cwd = join(root, "project")
    await mkdir(cwd, { recursive: true })
    const views = new ViewStore(join(root, "views.json"))
    const view = await views.create({ id: "dev", name: "开发" })
    await writeFile(join(view.directory, "AGENTS.md"), "视图规则")
    await writeFile(join(cwd, "AGENTS.md"), "项目规则")
    const pi = new RecordingViewFakePi()

    const core = new AizenCore({ cwd, store: new SessionStore(join(root, "sessions")), pi, views })
    expect(await core.dispatch({ type: "create_session", model, viewId: "dev" })).toEqual({ ok: true })
    let resources = pi.views.at(-1)
    expect(resources?.agentsFiles.map((file) => file.content)).toEqual(["视图规则"])
    expect(resources?.skillPaths).toEqual([join(view.directory, "skills")])

    await writeViewConfig(view.directory, { projectSources: "git-root", loadUserSkills: true })
    expect(await core.dispatch({ type: "create_session", model, viewId: "dev" })).toEqual({ ok: true })
    resources = pi.views.at(-1)
    expect(resources?.agentsFiles.map((file) => file.content)).toEqual(["项目规则", "视图规则"])
    await core.dispose()
  })

  test("loadUserSkills 关闭时视图不挂载用户层技能", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const cwd = join(root, "project")
    await mkdir(cwd, { recursive: true })
    const views = new ViewStore(join(root, "views.json"))
    const view = await views.create({ id: "dev", name: "开发" })
    await writeViewConfig(view.directory, { projectSources: "none", loadUserSkills: false })
    const pi = new RecordingViewFakePi()

    const core = new AizenCore({
      cwd,
      store: new SessionStore(join(root, "sessions")),
      pi,
      views,
      skills: await userSkillStore(root),
    })
    expect(await core.dispatch({ type: "create_session", model, viewId: "dev" })).toEqual({ ok: true })
    const resources = pi.views.at(-1)
    expect(resources?.skillPaths.some((path) => path.includes("userskill"))).toBe(false)

    await writeViewConfig(view.directory, { projectSources: "none", loadUserSkills: true })
    expect(await core.dispatch({ type: "create_session", model, viewId: "dev" })).toEqual({ ok: true })
    expect(pi.views.at(-1)?.skillPaths.some((path) => path.includes("userskill"))).toBe(true)
    await core.dispose()
  })

  test("新权限预设和审核方式进入轮次快照", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const pi = new FakePi()
    const core = new AizenCore({ cwd: root, store: new SessionStore(join(root, "sessions")), pi })
    expect(
      await core.dispatch({
        type: "create_session",
        model,
        viewId: null,
        permissionPreset: "plan",
        permissionReviewMode: "autoDeny",
      }),
    ).toEqual({ ok: true })
    expect(core.getSnapshot()).toMatchObject({
      currentPermissionPreset: "plan",
      currentPermissionReviewMode: "autoDeny",
    })
    await core.dispatch({ type: "send_prompt", text: "检查" })
    expect(pi.prompts.at(-1)).toMatchObject({ permissionPreset: "plan", permissionReviewMode: "autoDeny" })
    const sessionId = core.getSnapshot().currentSessionId
    expect(sessionId).toBeDefined()
    await core.dispose()

    const restoredPi = new FakePi()
    const restored = new AizenCore({ cwd: root, store: new SessionStore(join(root, "sessions")), pi: restoredPi })
    expect(await restored.dispatch({ type: "open_session", sessionId: sessionId ?? "" })).toEqual({ ok: true })
    expect(restored.getSnapshot()).toMatchObject({
      currentPermissionPreset: "plan",
      currentPermissionReviewMode: "autoDeny",
    })
    await restored.dispose()
  })

  test("视图配置非法时按默认值继续并报告，不阻塞创建会话", async () => {
    const root = await mkdtemp(join(tmpdir(), "aizen-core-"))
    directories.push(root)
    const cwd = join(root, "project")
    await mkdir(cwd, { recursive: true })
    const views = new ViewStore(join(root, "views.json"))
    const view = await views.create({ id: "dev", name: "开发" })
    await writeFile(join(view.directory, "config.json"), "{")
    const pi = new RecordingViewFakePi()

    const core = new AizenCore({ cwd, store: new SessionStore(join(root, "sessions")), pi, views })
    expect(await core.dispatch({ type: "create_session", model, viewId: "dev" })).toEqual({ ok: true })
    const resources = pi.views.at(-1)
    expect(resources?.skillPaths).toEqual([join(view.directory, "skills")])
    expect(core.getSnapshot().lastError).toContain("config.json 配置错误")
    await core.dispose()
  })
})
