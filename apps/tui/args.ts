export type ParsedArguments = {
  mode: "interactive"
  dataDirectory?: string
  collectPermissionGaps: boolean
}

/** 解析 TUI 启动参数；TUI 只负责交互式入口。 */
export function parseArguments(args: string[]): ParsedArguments {
  let dataDirectory: string | undefined
  let collectPermissionGaps = false
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "--data-dir") {
      if (dataDirectory !== undefined) throw new Error("--data-dir 不能重复指定")
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error("--data-dir 必须提供目录")
      dataDirectory = value
      continue
    }
    if (argument === "--collect-permission-gaps") {
      if (collectPermissionGaps) throw new Error("--collect-permission-gaps 不能重复指定")
      collectPermissionGaps = true
      continue
    }
    throw new Error(`未知的 TUI 参数：${argument ?? ""}`)
  }
  return { mode: "interactive", ...(dataDirectory ? { dataDirectory } : {}), collectPermissionGaps }
}

/** 返回 TUI 命令行用法。 */
export function usage(): string {
  return ["用法：", "  aizen-tui.exe [--data-dir <目录>] [--collect-permission-gaps]", "    启动多轮终端界面"].join(
    "\n",
  )
}
