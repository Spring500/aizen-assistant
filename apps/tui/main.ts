import { completeOnce, type CompleteOnceResult } from "../../packages/pi-adapter/complete.ts"
import { createInteractiveRenderer, promptLine } from "../../packages/tui-kit/interactive.ts"

const args = process.argv.slice(2)

function getFlagValue(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function reportAndExit(result: CompleteOnceResult): never {
  if (!result.text) {
    console.error(JSON.stringify({ stopReason: result.stopReason, errorMessage: result.errorMessage }))
    process.exit(1)
  }
  console.log(result.text)
  process.exit(0)
}

if (args.length === 0) {
  // 交互模式：通过 OpenTUI 分步收集 base-url / api-key / message，用于验证
  // OpenTUI 在编译后的单文件 exe 中能否接收真实键盘输入。
  const renderer = await createInteractiveRenderer()
  const baseUrl = await promptLine(renderer, "prompt-base-url", "Base URL: ")
  const apiKey = await promptLine(renderer, "prompt-api-key", "API Key: ", { mask: true })
  const message = await promptLine(renderer, "prompt-message", "Message: ")
  renderer.destroy()

  try {
    reportAndExit(await completeOnce(baseUrl, apiKey, message))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

const baseUrl = getFlagValue("--base-url")
const apiKey = getFlagValue("--api-key") ?? process.env.ANTHROPIC_API_KEY
const message = getFlagValue("--message")

if (!baseUrl || !apiKey || !message) {
  console.error("用法：")
  console.error("  aizen-tui.exe")
  console.error("  aizen-tui.exe --base-url <url> --api-key <key> --message <text>")
  console.error("  --api-key 可选填，也可通过环境变量 ANTHROPIC_API_KEY 传入")
  process.exit(2)
}

try {
  reportAndExit(await completeOnce(baseUrl, apiKey, message))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
