export type ParsedArguments = { mode: "interactive"; dataDirectory?: string }

/** 解析 TUI 启动参数；TUI 只负责交互式入口。 */
export function parseArguments(args: string[]): ParsedArguments {
  if (args.length === 0) return { mode: "interactive" }
  if (args.length !== 2 || args[0] !== "--data-dir" || !args[1]) {
    throw new Error("TUI 只接受 --data-dir <目录>")
  }
  return { mode: "interactive", dataDirectory: args[1] }
}

/** 返回 TUI 命令行用法。 */
export function usage(): string {
  return ["用法：", "  aizen-tui.exe [--data-dir <目录>]", "    启动多轮终端界面"].join("\n")
}
