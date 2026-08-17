/** 解析结果：交互模式或分发子命令（update / uninstall）。 */
export type ParsedArguments =
  | { command: "interactive"; dataDirectory?: string }
  | { command: "update"; releaseApi?: string }
  | { command: "uninstall"; yes: boolean; skipPath: boolean }

/** 解析 TUI 启动参数；首个参数为 update / uninstall 时进入分发命令，否则为交互模式。 */
export function parseArguments(args: string[]): ParsedArguments {
  // 全局剥离 --data-dir：由 launcher 注入，交互模式消费；update / uninstall 子命令忽略该参数。
  let dataDirectory: string | undefined
  const rest: string[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (argument === "--data-dir") {
      if (dataDirectory !== undefined) throw new Error("--data-dir 不能重复指定")
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error("--data-dir 必须提供目录")
      dataDirectory = value
      continue
    }
    rest.push(argument)
  }

  const first = rest[0]
  if (first === "update") {
    let releaseApi: string | undefined
    for (let index = 1; index < rest.length; index++) {
      const argument = rest[index]
      if (argument === "--release-api") {
        const value = rest[++index]
        if (!value || value.startsWith("--")) throw new Error("--release-api 必须提供值")
        releaseApi = value
        continue
      }
      throw new Error("update 只接受 --release-api 参数")
    }
    return { command: "update", ...(releaseApi ? { releaseApi } : {}) }
  }
  if (first === "uninstall") {
    const extra = rest.slice(1)
    if (extra.some((argument) => argument !== "--yes" && argument !== "--skip-path"))
      throw new Error("uninstall 只接受 --yes 与 --skip-path 参数")
    if (extra.filter((argument) => argument === "--yes").length > 1) throw new Error("uninstall 的 --yes 不能重复指定")
    if (extra.filter((argument) => argument === "--skip-path").length > 1)
      throw new Error("uninstall 的 --skip-path 不能重复指定")
    return { command: "uninstall", yes: extra.includes("--yes"), skipPath: extra.includes("--skip-path") }
  }

  // 交互模式：剩余参数必须为空，data 目录已在全局剥离阶段解析
  if (rest.length > 0) throw new Error(`未知的 TUI 参数：${rest[0] ?? ""}`)
  return { command: "interactive", ...(dataDirectory ? { dataDirectory } : {}) }
}

/** 返回 TUI 命令行用法。 */
export function usage(): string {
  return [
    "用法：",
    "  aizen-assistant [--data-dir <目录>]",
    "    启动多轮终端界面（--data-dir 由 launcher 注入，通常无需手动指定）",
    "  aizen-assistant update [--release-api <url>]",
    "    检查并安装最新版本（--release-api 指定发布 API 地址）",
    "  aizen-assistant uninstall [--yes] [--skip-path]",
    "    卸载并回滚 PATH（--yes 跳过确认；--skip-path 不回滚 PATH）",
  ].join("\n")
}
