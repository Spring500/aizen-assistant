/**
 * 共享命令行参数解析：支持 `--flag value` 与 `--flag=value` 两种形式。
 * 供 build-tui.ts / package-release.ts / mock-release-server.ts 等构建与发布工具复用。
 */

/** 解析参数；allowedFlags 为允许的完整 flag 列表（如 ["--target"]）。返回 flag 去前缀后的键值映射。 */
export function parseCliArgs(args: string[], allowedFlags: string[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === undefined) continue
    if (allowedFlags.includes(argument)) {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error(`${argument} 必须提供值`)
      values[argument.slice(2)] = value
      continue
    }
    if (argument.startsWith("--")) {
      const [key, value] = argument.slice(2).split("=")
      if (!key || !value) throw new Error(`${argument} 必须提供值`)
      if (!allowedFlags.includes(`--${key}`)) throw new Error(`未知参数：${argument}`)
      values[key] = value
      continue
    }
    throw new Error(`未知参数：${argument ?? ""}`)
  }
  return values
}
