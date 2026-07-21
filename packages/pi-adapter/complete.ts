import { ModelRuntime } from "@earendil-works/pi-coding-agent"

const gateModelId = "claude-sonnet-4-6"

export type CompleteOnceResult = {
  text: string
  stopReason: string
  errorMessage: string | undefined
}

/**
 * 向固定测试模型（claude-sonnet-4-6）发起一次单轮补全请求。
 *
 * 供 `apps/tui/main.ts`（生产入口）与 `packages/pi-adapter/gate.ts`（架构门禁）
 * 共用，避免"查找模型 → 设置 baseUrl → 调用 complete → 提取文本"的逻辑重复。
 */
export async function completeOnce(baseUrl: string, apiKey: string, message: string): Promise<CompleteOnceResult> {
  const modelRuntime = await ModelRuntime.create()
  const sourceModel = modelRuntime.getModels().find((m) => m.provider === "anthropic" && m.id === gateModelId)
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
