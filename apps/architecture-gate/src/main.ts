import { ModelRuntime } from "@earendil-works/pi-coding-agent"

const args = process.argv.slice(2)

const baseUrl = args[args.indexOf("--base-url") + 1]
const apiKey = args[args.indexOf("--api-key") + 1] ?? process.env.ANTHROPIC_API_KEY
const message = args[args.indexOf("--message") + 1]

if (!baseUrl || !apiKey || !message) {
  console.error("用法：aizen-architecture-gate.exe --prompt --base-url <url> --api-key <key> --message <text>")
  console.error("  --api-key 可选填，也可通过环境变量 ANTHROPIC_API_KEY 传入")
  process.exit(2)
}

const modelRuntime = await ModelRuntime.create()
const sourceModel = modelRuntime.getModels().find((m) => m.provider === "anthropic" && m.id === "claude-sonnet-4-6")
if (!sourceModel) {
  console.error("固定测试模型不存在")
  process.exit(1)
}

sourceModel.baseUrl = baseUrl
process.env.ANTHROPIC_API_KEY = apiKey

const result = await modelRuntime.complete(
  sourceModel,
  { messages: [{ role: "user" as const, content: message, timestamp: Date.now() }] },
  { auth: { apiKey } },
)

const responseText = result.content?.[0] && "text" in result.content[0] ? result.content[0].text : ""
if (!responseText) {
  console.error(JSON.stringify({ stopReason: result.stopReason, errorMessage: result.errorMessage }))
  process.exit(1)
}
console.log(responseText)
