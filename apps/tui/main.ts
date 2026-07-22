import { completeOnce, type CompleteOnceResult } from "../../packages/pi-adapter/complete.ts"
import { createInteractiveRenderer, promptLine } from "../../packages/tui-kit/interactive.ts"

const args = process.argv.slice(2)
const isPlain = args.includes("--plain")

function getFlagValue(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function printUsageAndExit(): never {
  console.error("用法：")
  console.error("  aizen-tui.exe")
  console.error("    启动 OpenTUI 交互界面，分步收集 base-url / api-key / message")
  console.error("  aizen-tui.exe --plain --base-url <url> --api-key <key> --message <text>")
  console.error("    非交互模式：读取参数、打印响应文本、退出，供日志、管道、CI 使用")
  console.error("    --api-key 可选填，也可通过环境变量 ANTHROPIC_API_KEY 传入")
  process.exit(2)
}

function reportAndExit(result: CompleteOnceResult): never {
  if (!result.text) {
    console.error(JSON.stringify({ stopReason: result.stopReason, errorMessage: result.errorMessage }))
    process.exit(1)
  }
  console.log(result.text)
  process.exit(0)
}

async function runOnce(baseUrl: string, apiKey: string, message: string): Promise<never> {
  try {
    reportAndExit(await completeOnce(baseUrl, apiKey, message))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

if (isPlain) {
  // --plain：非交互输出，供日志、管道、CI 使用（见方案与路线图 §3.4）。
  // M1 阶段的行为是"读取三个参数、发一次请求、打印结果、退出"；M2 重做
  // TUI 时，--plain 的语义不变，但底层会换成走真实的流式 prompt。
  const baseUrl = getFlagValue("--base-url")
  const apiKey = getFlagValue("--api-key") ?? process.env.ANTHROPIC_API_KEY
  const message = getFlagValue("--message")
  if (!baseUrl || !apiKey || !message) printUsageAndExit()
  await runOnce(baseUrl, apiKey, message)
} else if (args.length > 0) {
  // 传了参数但没带 --plain：语义不明确（--base-url 等参数只在 --plain
  // 下有意义），报用法错误，不静默猜测意图。
  printUsageAndExit()
} else {
  // 默认：OpenTUI 交互模式。分步收集 base-url / api-key（遮盖显示）/
  // message，用于验证 OpenTUI 在编译后的单文件 exe 中能否接收真实键盘
  // 输入。M2 会把这里扩展成真正的聊天界面。
  const renderer = await createInteractiveRenderer()
  const baseUrl = await promptLine(renderer, "prompt-base-url", "Base URL: ")
  const apiKey = await promptLine(renderer, "prompt-api-key", "API Key: ", { mask: true })
  const message = await promptLine(renderer, "prompt-message", "Message: ")
  renderer.destroy()
  await runOnce(baseUrl, apiKey, message)
}
