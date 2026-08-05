import { expect } from "bun:test"
import { createDiagnosticTest } from "./utils/diagnostic-test.ts"
import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { PhotonImage } from "@silvia-odwyer/photon-node"
import { startMockServer } from "./utils/mock-server.ts"

const test = createDiagnosticTest({ timeoutMs: 15_000 })

/**
 * 架构可行性验证：一次性回答"pi SDK、OpenTUI、Photon 这几个第三方依赖，
 * 能不能一起编译进 Bun 单文件可执行程序，并在没有预装 Node/Bun 的机器上
 * 正常运行"这个问题。这不是产品功能，而是能不能继续在这套技术栈上开发
 * 产品功能的前提；下面四项检查分别验证这个问题的四个子命题，只要有一项
 * 失败，就说明技术选型存在问题，需要停下来重新决策。
 *
 * 这些检查测的都是第三方 SDK/库本身的能力（pi SDK 的内联扩展机制、
 * OpenTUI 的原生渲染器、Photon 的 WASM 编码），跟本项目自己写的适配层
 * （packages/pi-adapter、packages/tui-kit）代码基本无关，所以整体放在
 * tests/ 下，不掺进生产代码目录，避免被误认为是产品逻辑的一部分。
 */

/** 单项检查的结果：是否通过，以及成功/失败的详细信息（用于报告与调试）。 */
type CheckResult = { passed: boolean; detail: string }

/** 四项检查汇总后的报告。 */
type ArchitectureVerificationReport = {
  piSdk: CheckResult
  openTui: CheckResult
  photonWasm: CheckResult
  mockServer: CheckResult
}

const architectureLogPrefix = "[架构验证]"

/** 记录架构验证阶段的开始、完成、失败和耗时，不改变原有执行顺序。 */
async function traceArchitectureStage<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
  const startedAt = performance.now()
  console.log(`${architectureLogPrefix} 开始：${name}`)
  try {
    const result = await operation()
    console.log(`${architectureLogPrefix} 完成：${name}，耗时 ${Math.round(performance.now() - startedAt)}ms`)
    return result
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(
      `${architectureLogPrefix} 失败：${name}，耗时 ${Math.round(performance.now() - startedAt)}ms，错误：${detail}`,
    )
    throw error
  }
}

/**
 * 把一个"可能抛错"的检查函数统一包装成 { passed, detail } 结构：抛错时
 * 不让异常向上冒泡中断整批检查，而是记录下来，方便一次性看到四项检查里
 * 哪些过了、哪些没过、没过的原因是什么。
 */
async function check(name: string, operation: () => Promise<string> | string): Promise<CheckResult> {
  try {
    return { passed: true, detail: await traceArchitectureStage(name, operation) }
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    return { passed: false, detail: `${name}: ${detail}` }
  }
}

const embeddedViewText = "AizenAssistant 架构可行性验证视图"

/**
 * 验证 pi SDK 的两个关键机制在编译产物里可用：
 *
 * 1. 内联扩展（inline extension）：不依赖文件系统上的扩展文件，直接把
 *    扩展工厂函数传给 DefaultResourceLoader，验证它确实被执行——这是
 *    实现"每轮额外消息"和"视图式提示词组织"这两项核心定制能力
 *    将来要用到的机制，如果编译产物里失效，这两项能力就无法实现。
 * 2. 内置视图：用 systemPromptOverride 替换默认系统提示词，验证
 *    ResourceLoader 真的读到了覆盖后的内容，而不是回退到默认值。
 *
 * 最后还验证 AgentSession 能绑定到一个固定的测试模型（claude-sonnet-4-6），
 * 证明 pi SDK 的会话创建流程在这套编译环境下能跑通。
 */
async function checkPiSdk(): Promise<string> {
  let inlineExtensionLoaded = false
  const extension: InlineExtension = {
    name: "architecture-verification",
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
    systemPromptOverride: () => embeddedViewText,
  })
  await traceArchitectureStage("piSdk / 重载资源", () => loader.reload())

  if (!inlineExtensionLoaded) throw new Error("内联扩展工厂未执行")
  if (loader.getSystemPrompt() !== embeddedViewText) throw new Error("内置视图未进入 ResourceLoader")

  const modelRuntime = await traceArchitectureStage("piSdk / 创建模型运行时", () =>
    ModelRuntime.create({ allowModelNetwork: false }),
  )
  const model = modelRuntime.getModels().find((m) => m.provider === "anthropic" && m.id === "claude-sonnet-4-6")
  if (!model) throw new Error("固定测试模型不存在")
  const { session, extensionsResult } = await traceArchitectureStage("piSdk / 创建 AgentSession", () =>
    createAgentSession({
      cwd: process.cwd(),
      model,
      modelRuntime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(),
      noTools: "all",
    }),
  )

  try {
    if (extensionsResult.errors.length > 0) {
      throw new Error(extensionsResult.errors.map((item) => `${item.path}: ${item.error}`).join("\n"))
    }
    if (session.model?.id !== model.id) throw new Error("AgentSession 未使用固定模型")
    return `AgentSession=${session.sessionId}; model=${model.id}; inlineExtension=true; embeddedView=true`
  } finally {
    await traceArchitectureStage("piSdk / 释放 AgentSession", () => session.dispose())
  }
}

/**
 * 验证 OpenTUI 的原生渲染器在编译产物里可用：创建一个离屏测试渲染器，
 * 往画面里加一段文本，渲染一帧后截取字符画面，确认文本真的出现在画面
 * 上——证明 OpenTUI 的原生绑定（不是占位实现）被正确加载并渲染，不是
 * 加载失败后静默降级成什么都不画。
 */
async function checkOpenTui(): Promise<string> {
  const setup = await traceArchitectureStage("openTui / 创建测试渲染器", () =>
    createTestRenderer({ width: 48, height: 8 }),
  )
  try {
    setup.renderer.root.add(
      new TextRenderable(setup.renderer, { id: "verify-opentui", content: "AizenAssistant OpenTUI" }),
    )
    await traceArchitectureStage("openTui / 渲染帧", () => setup.renderOnce())
    const frame = setup.captureCharFrame()
    if (!frame.includes("AizenAssistant OpenTUI")) throw new Error("OpenTUI 帧缺少测试文本")
    return "OpenTUI native renderer=true"
  } finally {
    await traceArchitectureStage("openTui / 销毁测试渲染器", () => setup.renderer.destroy())
  }
}

/**
 * 验证 Photon（pi 自身依赖的图片处理库，底层是 WASM）在编译产物里可用：
 * 构造一个 1x1 的纯红色像素，让 Photon 编码成 PNG，检查输出字节的前 4
 * 个字节是否等于 PNG 文件签名（0x89 'P' 'N' 'G'）——如果 WASM 模块没有
 * 正确随单文件产物打包/加载，这里会拿到空字节或垃圾数据而不是合法的
 * PNG 文件头，从而暴露问题。
 */
function checkPhoton(): string {
  const image = new PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1)
  console.log(`${architectureLogPrefix} 状态：photonWasm / PhotonImage 已创建`)
  try {
    if (image.get_width() !== 1 || image.get_height() !== 1) throw new Error("PhotonImage 尺寸不正确")
    const png = image.get_bytes()
    console.log(`${architectureLogPrefix} 状态：photonWasm / PNG 编码完成，字节数 ${png.byteLength}`)
    if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
      throw new Error("Photon WASM 未生成 PNG")
    }
    return `Photon WASM=true; pngBytes=${png.byteLength}`
  } finally {
    image.free()
    console.log(`${architectureLogPrefix} 状态：photonWasm / PhotonImage 已释放`)
  }
}

/** 验证 pi provider 的 HTTP 请求链路可用。 */
async function checkMockServer(): Promise<string> {
  const expectedText = "架构可行性验证：Mock 链路通过"
  const mock = await traceArchitectureStage("mockServer / 启动服务", () => startMockServer(expectedText))
  const modelRuntime = await traceArchitectureStage("mockServer / 创建模型运行时", () =>
    ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    }),
  )
  const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-6")
  if (!model) throw new Error("固定测试模型不存在")
  await traceArchitectureStage("mockServer / 设置运行时认证", () =>
    modelRuntime.setRuntimeApiKey("anthropic", "dummy-skip-validation"),
  )
  model.baseUrl = mock.url
  try {
    const result = await traceArchitectureStage("mockServer / 完成模型请求", () =>
      modelRuntime.complete(
        model,
        { messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
        { auth: { apiKey: "dummy-skip-validation" } },
      ),
    )
    const text = result.content.find((part) => part.type === "text")?.text ?? ""
    if (!text.includes(expectedText)) throw new Error(`Mock 响应不匹配：${text}`)
    return `Mock pi provider=true; expectedText="${expectedText}"`
  } finally {
    await traceArchitectureStage("mockServer / 停止服务", () => mock.stop())
  }
}

/** 依次跑完四项检查，汇总成一份报告。 */
async function runArchitectureVerification(): Promise<ArchitectureVerificationReport> {
  return {
    piSdk: await check("piSdk", checkPiSdk),
    openTui: await check("openTui", checkOpenTui),
    photonWasm: await check("photonWasm", checkPhoton),
    mockServer: await check("mockServer", checkMockServer),
  }
}

/** 四项检查是否全部通过。 */
function allChecksPassed(report: ArchitectureVerificationReport): boolean {
  return report.piSdk.passed && report.openTui.passed && report.photonWasm.passed && report.mockServer.passed
}

test("业务 TUI 不直接依赖 OpenTUI", async () => {
  const glob = new Bun.Glob("apps/tui/**/*.ts")
  for await (const path of glob.scan({ cwd: process.cwd() })) {
    const source = await Bun.file(path).text()
    expect(source).not.toContain('from "@opentui/core"')
  }
})

test("架构可行性验证：pi SDK、内联扩展、内置视图、OpenTUI、Photon 和 HTTP 链路全部可用", async () => {
  const report = await runArchitectureVerification()

  expect(report.piSdk.passed).toBeTrue()
  expect(report.openTui.passed).toBeTrue()
  expect(report.photonWasm.passed).toBeTrue()
  expect(report.mockServer.passed).toBeTrue()
  expect(allChecksPassed(report)).toBeTrue()
})
