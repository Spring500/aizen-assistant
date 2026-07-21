import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { isGatePassed, runSelfTest } from "./self-test.ts"

const args = process.argv.slice(2)

if (args.includes("--self-test")) {
  const checks = await runSelfTest()
  const passed = isGatePassed(checks)
  console.log(JSON.stringify({ passed, checks }))
  if (!passed) process.exitCode = 1
} else if (args.includes("--prompt")) {
  const baseUrl = args[args.indexOf("--base-url") + 1]
  const apiKey = args[args.indexOf("--api-key") + 1] ?? process.env.ANTHROPIC_API_KEY
  const message = args[args.indexOf("--message") + 1]

  if (!baseUrl) {
    console.error("缺少 --base-url")
    process.exit(2)
  }
  if (!apiKey) {
    console.error("缺少 --api-key（或环境变量 ANTHROPIC_API_KEY）")
    process.exit(2)
  }
  if (!message) {
    console.error("缺少 --message")
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
} else {
  console.error("用法：")
  console.error("  aizen-architecture-gate.exe --self-test")
  console.error("  aizen-architecture-gate.exe --prompt --base-url <url> --api-key <key> --message <text>")
  process.exit(2)
}
