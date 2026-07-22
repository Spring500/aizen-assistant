// TUI 生产入口，三种运行方式：
//   1. --plain：非交互模式，读取 --base-url/--api-key/--message，发一次
//      请求、打印结果、退出（供日志、管道、CI 使用）。
//   2. 不带任何参数：OpenTUI 交互模式，分步收集同样三项参数。
//   3. 带了参数但没带 --plain：视为用法错误，报错退出（避免静默猜测意图）。
import { completeOnce, type CompleteOnceResult } from "../../packages/pi-adapter/complete.ts"
import { createInteractiveRenderer, promptLine } from "../../packages/tui-kit/interactive.ts"

const args = process.argv.slice(2)
const isPlain = args.includes("--plain")

/** 取出 `flag` 后面紧跟的那个参数值；`flag` 不存在时返回 undefined。 */
function getFlagValue(flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** 打印用法说明到 stderr 并以退出码 2 结束进程（约定：参数用法错误）。 */
function printUsageAndExit(): never {
  console.error("用法：")
  console.error("  aizen-tui.exe")
  console.error("    启动 OpenTUI 交互界面，分步收集 base-url / api-key / message")
  console.error("  aizen-tui.exe --plain --base-url <url> --api-key <key> --message <text>")
  console.error("    非交互模式：读取参数、打印响应文本、退出，供日志、管道、CI 使用")
  console.error("    --api-key 可选填，也可通过环境变量 ANTHROPIC_API_KEY 传入")
  process.exit(2)
}

/**
 * 根据 completeOnce 的结果决定输出与退出码：拿到文本就打印到 stdout 并
 * 以 0 退出；没拿到文本（请求失败/被拒绝）就把 stopReason/errorMessage
 * 打到 stderr 并以 1 退出。这是 --plain 和交互模式共用的收尾逻辑。
 */
function reportAndExit(result: CompleteOnceResult): never {
  if (!result.text) {
    console.error(JSON.stringify({ stopReason: result.stopReason, errorMessage: result.errorMessage }))
    process.exit(1)
  }
  console.log(result.text)
  process.exit(0)
}

/**
 * 发起一次补全请求并结束进程：成功走 reportAndExit，异常（比如网络
 * 连不上、固定模型不存在）打印错误信息后以退出码 1 结束。--plain 与
 * 交互模式收集完参数后都调用这个函数，行为完全一致。
 */
async function runOnce(baseUrl: string, apiKey: string, message: string): Promise<never> {
  try {
    reportAndExit(await completeOnce(baseUrl, apiKey, message))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

if (isPlain) {
  // --plain 是非交互、脚本友好的入口：读三个参数、发一次请求、打印结果、
  // 退出，没有任何交互等待，适合日志、管道、CI 场景。这个"非交互"的
  // 定位是稳定的；如果以后请求逻辑换成支持流式输出，--plain 仍然只在
  // 请求结束后一次性打印最终结果，不会变成交互式等待。
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
  // message，验证 OpenTUI 在编译后的单文件 exe 中能接收真实键盘输入。
  // 目前只是"问完三项就发一次请求"，还不是完整的多轮聊天界面。
  const renderer = await createInteractiveRenderer()
  const baseUrl = await promptLine(renderer, "prompt-base-url", "Base URL: ")
  const apiKey = await promptLine(renderer, "prompt-api-key", "API Key: ", { mask: true })
  const message = await promptLine(renderer, "prompt-message", "Message: ")
  renderer.destroy()
  await runOnce(baseUrl, apiKey, message)
}
