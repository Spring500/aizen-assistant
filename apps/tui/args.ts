export type ParsedArguments = {
  mode: "interactive"
  dataDirectory?: string
}

/** 解析 TUI 启动参数；TUI 只负责交互式入口。 */
export function parseArguments(args: string[]): ParsedArguments {
  let dataDirectory: string | undefined
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "--data-dir") {
      if (dataDirectory !== undefined) throw new Error("--data-dir 不能重复指定")
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error("--data-dir 必须提供目录")
      dataDirectory = value
      continue
    }
    throw new Error(`未知的 TUI 参数：${argument ?? ""}`)
  }
  return { mode: "interactive", ...(dataDirectory ? { dataDirectory } : {}) }
}

/** 返回 TUI 命令行用法。 */
export function usage(): string {
  return ["用法：", "  aizen-tui.exe [--data-dir <目录>]", "    启动多轮终端界面"].join("\n")
}
