import { ModelRuntime } from "@earendil-works/pi-coding-agent"

const baseUrl = process.argv[2]
if (!baseUrl) throw new Error("缺少 mock API 地址")
const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
await runtime.setRuntimeApiKey("anthropic", "distribution-probe")
const source = runtime.getModel("anthropic", "claude-sonnet-4-6")
if (!source) throw new Error("无法加载固定探针模型")
const model = { ...source, baseUrl }
const message = await runtime.completeSimple(model, {
  messages: [{ role: "user", content: "probe", timestamp: Date.now() }],
})
if (message.stopReason === "error") throw new Error(message.errorMessage ?? "模型请求失败")
const text = message.content
  .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
  .map((part) => part.text)
  .join("")
process.stdout.write(text)
