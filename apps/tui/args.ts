export type PlainArguments = { baseUrl: string; apiKey: string; message: string }
export type ParsedArguments = { mode: "interactive" } | { mode: "plain"; values: PlainArguments }

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

export function parseArguments(args: string[], env: Record<string, string | undefined>): ParsedArguments {
  if (args.length === 0) return { mode: "interactive" }
  if (!args.includes("--plain")) throw new Error("交互模式不接受命令行参数")
  const baseUrl = flagValue(args, "--base-url")
  const apiKey = flagValue(args, "--api-key") ?? env.ANTHROPIC_API_KEY
  const message = flagValue(args, "--message")
  if (!baseUrl || !apiKey || !message) throw new Error("--plain 缺少 base-url、api-key 或 message")
  return { mode: "plain", values: { baseUrl, apiKey, message } }
}

export function usage(): string {
  return [
    "用法：",
    "  aizen-tui.exe",
    "    启动多轮终端界面",
    "  aizen-tui.exe --plain --base-url <url> --api-key <key> --message <text>",
    "    单次、无状态调用；--api-key 也可由 ANTHROPIC_API_KEY 提供",
  ].join("\n")
}
