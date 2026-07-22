import { ModelRuntime } from "@earendil-works/pi-coding-agent"

// 目前没有模型选择功能：--plain 和交互模式都还不支持用户挑选模型，
// 先固定用这一个模型把请求链路跑通。
const fixedModelId = "claude-sonnet-4-6"

export type CompleteOnceResult = {
  /** 助手回复的纯文本内容；请求失败或未返回文本时为空字符串。 */
  text: string
  /** pi 报告的结束原因（如 "stop"、"length"、"error"、"aborted"）。 */
  stopReason: string
  /** 出错时 pi 附带的错误说明；成功时为 undefined。 */
  errorMessage: string | undefined
}

/**
 * 向固定测试模型（claude-sonnet-4-6）发起一次单轮补全请求。
 *
 * 供 `apps/tui/main.ts`（生产入口，非交互模式与交互模式共用）与
 * `tests/architecture-verification.test.ts`（架构可行性验证）共用，
 * 避免"查找模型 → 设置 baseUrl → 调用 complete → 提取文本"的逻辑重复。
 */
export async function completeOnce(baseUrl: string, apiKey: string, message: string): Promise<CompleteOnceResult> {
  const modelRuntime = await ModelRuntime.create()
  const sourceModel = modelRuntime.getModels().find((m) => m.provider === "anthropic" && m.id === fixedModelId)
  if (!sourceModel) throw new Error("固定测试模型不存在")

  sourceModel.baseUrl = baseUrl

  const previousApiKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = apiKey
  try {
    const result = await modelRuntime.complete(
      sourceModel,
      { messages: [{ role: "user" as const, content: message, timestamp: Date.now() }] },
      { auth: { apiKey } },
    )

    const contentBlock = result.content?.[0]
    const text = contentBlock && "text" in contentBlock ? contentBlock.text : ""
    return { text, stopReason: result.stopReason, errorMessage: result.errorMessage }
  } finally {
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousApiKey
  }
}
