/** 解析结果：交互模式或分发子命令（update / uninstall）。 */
export type ParsedArguments =
  | { command: "interactive"; dataDirectory?: string }
  | { command: "update"; releaseApi?: string }
  | { command: "uninstall"; yes: boolean }

/** 解析 TUI 启动参数；首个参数为 update / uninstall 时进入分发命令，否则为交互模式。 */
export function parseArguments(args: string[]): ParsedArguments {
  const first = args[0]
  if (first === "update") {
    let releaseApi: string | undefined
    for (let index = 1; index < args.length; index++) {
      const argument = args[index]
      if (argument === "--release-api") {
        const value = args[++index]
        if (!value || value.startsWith("--")) throw new Error("--release-api 必须提供值")
        releaseApi = value
        continue
      }
      throw new Error("update 只接受 --release-api 参数")
    }
    return { command: "update", ...(releaseApi ? { releaseApi } : {}) }
  }
  if (first === "uninstall") {
    const extra = args.slice(1)
    if (extra.some((argument) => argument !== "--yes")) throw new Error("uninstall 只接受 --yes 参数")
    return { command: "uninstall", yes: extra.includes("--yes") }
  }

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
  return { command: "interactive", ...(dataDirectory ? { dataDirectory } : {}) }
}

/** 返回 TUI 命令行用法。 */
export function usage(): string {
  return [
    "用法：",
    "  aizen-assistant [--data-dir <目录>]",
    "    启动多轮终端界面",
    "  aizen-assistant update [--release-api <url>]",
    "    检查并安装最新版本（--release-api 指定发布 API 地址）",
    "  aizen-assistant uninstall [--yes]",
    "    卸载并回滚 PATH（--yes 跳过确认）",
  ].join("\n")
}
