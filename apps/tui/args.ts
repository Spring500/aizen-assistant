/** 解析结果：交互模式或分发子命令（update / uninstall）。 */
export type ParsedArguments =
  | { command: "interactive"; dataDirectory?: string; collectPermissionGaps: boolean }
  | { command: "update" }
  | { command: "uninstall"; yes: boolean }

/** 解析 TUI 启动参数；首个参数为 update / uninstall 时进入分发命令，否则为交互模式。 */
export function parseArguments(args: string[]): ParsedArguments {
  const first = args[0]
  if (first === "update") {
    if (args.length > 1) throw new Error("update 不接受额外参数")
    return { command: "update" }
  }
  if (first === "uninstall") {
    const extra = args.slice(1)
    if (extra.some((argument) => argument !== "--yes")) throw new Error("uninstall 只接受 --yes 参数")
    return { command: "uninstall", yes: extra.includes("--yes") }
  }

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
  return { command: "interactive", ...(dataDirectory ? { dataDirectory } : {}), collectPermissionGaps }
}

/** 返回 TUI 命令行用法。 */
export function usage(): string {
  return [
    "用法：",
    "  aizen-assistant [--data-dir <目录>] [--collect-permission-gaps]",
    "    启动多轮终端界面",
    "  aizen-assistant update",
    "    检查并安装最新版本",
    "  aizen-assistant uninstall [--yes]",
    "    卸载并回滚 PATH（--yes 跳过确认）",
  ].join("\n")
}
