/**
 * 参数化构建 TUI 可执行文件，供 CI 发布矩阵复用。
 *
 * 用法：
 *   bun run build:tui                       # 默认 target=bun-windows-x64（兼容本地 verify 流程）
 *   bun run build:tui --target bun-linux-x64
 *   bun run build:tui --target=bun-darwin-arm64
 *
 * 产物命名：Windows 平台输出 dist/aizen-assistant.exe，其余平台输出 dist/aizen-assistant。
 * 所有平台产物均为单文件独立可执行程序，运行时不依赖 Node.js / Bun。
 *
 * 说明：实际构建委托给 `bun build --compile` 命令行（与发布流程一致）。
 * 经实测，Bun.build API 的 compile 模式产物存在入口不执行的问题，故不使用。
 */

import { $ } from "bun"
import { join } from "node:path"

/** Windows 平台 target 集合，产物需带 .exe 后缀。 */
const WINDOWS_TARGETS = new Set(["bun-windows-x64", "bun-windows-arm64"])

/** 解析 --target 参数；不提供时回退到 bun-windows-x64。 */
function parseTarget(args: string[]): string {
  let target = "bun-windows-x64"
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument === "--target") {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error("--target 必须提供目标，如 bun-linux-x64")
      target = value
      continue
    }
    if (argument.startsWith("--target=")) {
      target = argument.slice("--target=".length)
      continue
    }
    throw new Error(`未知参数：${argument ?? ""}`)
  }
  return target
}

/** 根据 target 推断产物文件名（Windows 带 .exe 后缀）。 */
function executableName(target: string): string {
  return WINDOWS_TARGETS.has(target) ? "aizen-assistant.exe" : "aizen-assistant"
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2))
  const name = executableName(target)
  await $`bun build --compile --target=${target} --outfile=${join("dist", name)} apps/tui/main.ts`
  console.log(`TUI 构建完成：dist/${name}（target=${target}）`)
}

if (import.meta.main) await main()
