import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { startMockServer } from "../../tests/contract/mock-server.ts"

const gateViewText = "AizenAssistant 架构门禁视图"

export async function checkPiSdk(): Promise<string> {
  let inlineExtensionLoaded = false
  const extension: InlineExtension = {
    name: "architecture-gate",
    factory: () => {
      inlineExtensionLoaded = true
    },
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  })
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    extensionFactories: [extension],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => gateViewText,
  })
  await loader.reload()

  if (!inlineExtensionLoaded) throw new Error("内联扩展工厂未执行")
  if (loader.getSystemPrompt() !== gateViewText) throw new Error("内置视图未进入 ResourceLoader")

  const modelRuntime = await ModelRuntime.create()
  const model = modelRuntime.getModels().find((m) => m.provider === "anthropic" && m.id === "claude-sonnet-4-6")
  if (!model) throw new Error("固定测试模型不存在")
  const { session, extensionsResult } = await createAgentSession({
    cwd: process.cwd(),
    model,
    modelRuntime,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
    noTools: "all",
  })

  try {
    if (extensionsResult.errors.length > 0) {
      throw new Error(extensionsResult.errors.map((item) => `${item.path}: ${item.error}`).join("\n"))
    }
    if (session.model?.id !== model.id) throw new Error("AgentSession 未使用固定模型")
    return `AgentSession=${session.sessionId}; model=${model.id}; inlineExtension=true; embeddedView=true`
  } finally {
    session.dispose()
  }
}

export async function checkMockServer(): Promise<string> {
  const expectedText = "架构门禁 Mock 链路通过"
  const mock = startMockServer(expectedText)
  try {
    process.env.ANTHROPIC_API_KEY = "dummy-skip-validation"

    const modelRuntime = await ModelRuntime.create()
    const sourceModel = modelRuntime.getModels().find((m) => m.provider === "anthropic" && m.id === "claude-sonnet-4-6")
    if (!sourceModel) throw new Error("固定测试模型不存在")

    sourceModel.baseUrl = mock.url

    const result = await modelRuntime.complete(
      sourceModel,
      { messages: [{ role: "user" as const, content: "test", timestamp: Date.now() }] },
      { auth: { apiKey: "dummy" } },
    )

    const contentBlock = result.content?.[0]
    const responseText = contentBlock && "text" in contentBlock ? contentBlock.text : undefined
    if (!responseText?.includes(expectedText)) {
      throw new Error(`Mock 响应不匹配，期望包含 "${expectedText}"，实际为 "${responseText}"`)
    }
    return `Mock pi provider=true; expectedText="${expectedText}"`
  } finally {
    mock.stop()
    delete process.env.ANTHROPIC_API_KEY
  }
}
