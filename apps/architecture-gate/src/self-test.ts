import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { createTestRenderer } from "@opentui/core/testing"
import { TextRenderable } from "@opentui/core"
import { PhotonImage } from "@silvia-odwyer/photon-node"
import { DEFAULT_VIEW } from "./default-view.ts"
import { startMockServer } from "./mock-server.ts"

export type GateCheck = { passed: boolean; detail: string }
export type GateReport = {
  piSdk: GateCheck
  openTui: GateCheck
  photonWasm: GateCheck
  mockServer: GateCheck
}

async function check(name: string, operation: () => Promise<string> | string): Promise<GateCheck> {
  try {
    return { passed: true, detail: await operation() }
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    return { passed: false, detail: `${name}: ${detail}` }
  }
}

async function checkPiSdk(): Promise<string> {
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
    systemPromptOverride: () => DEFAULT_VIEW,
  })
  await loader.reload()

  if (!inlineExtensionLoaded) throw new Error("内联扩展工厂未执行")
  if (loader.getSystemPrompt() !== DEFAULT_VIEW) throw new Error("内置视图未进入 ResourceLoader")

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

async function checkOpenTui(): Promise<string> {
  const setup = await createTestRenderer({ width: 48, height: 8 })
  try {
    setup.renderer.root.add(new TextRenderable(setup.renderer, { id: "gate", content: "AizenAssistant OpenTUI" }))
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    if (!frame.includes("AizenAssistant OpenTUI")) throw new Error("OpenTUI 帧缺少测试文本")
    return "OpenTUI native renderer=true"
  } finally {
    setup.renderer.destroy()
  }
}

function checkPhoton(): string {
  const image = new PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1)
  try {
    if (image.get_width() !== 1 || image.get_height() !== 1) throw new Error("PhotonImage 尺寸不正确")
    const png = image.get_bytes()
    if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
      throw new Error("Photon WASM 未生成 PNG")
    }
    return `Photon WASM=true; pngBytes=${png.byteLength}`
  } finally {
    image.free()
  }
}

async function checkMockServer(): Promise<string> {
  const expectedText = "架构门禁 Mock 链路通过"
  const mock = startMockServer(expectedText)
  try {
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "test" }],
      max_tokens: 10,
      stream: true,
    })
    const response = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "dummy",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body,
    })
    if (!response.ok) throw new Error(`Mock 返回 HTTP ${response.status}`)

    const text = await response.text()
    if (!text.includes(expectedText)) {
      throw new Error(`Mock 响应不匹配，期望包含 "${expectedText}"，实际前 200 字符为 "${text.substring(0, 200)}"`)
    }
    return `Mock HTTP stream=true; expectedText="${expectedText}"`
  } finally {
    mock.stop()
  }
}

export async function runSelfTest(): Promise<GateReport> {
  return {
    piSdk: await check("piSdk", checkPiSdk),
    openTui: await check("openTui", checkOpenTui),
    photonWasm: await check("photonWasm", checkPhoton),
    mockServer: await check("mockServer", checkMockServer),
  }
}

export function isGatePassed(report: GateReport): boolean {
  return Object.values(report).every((item) => item.passed)
}
