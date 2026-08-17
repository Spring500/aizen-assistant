/**
 * 参数化构建 launcher 可执行文件，供 CI 发布矩阵复用。
 *
 * 用法：
 *   bun run build:launcher                       # 默认 target=bun-windows-x64
 *   bun run build:launcher --target bun-windows-x64
 *
 * 产物命名：Windows 平台输出 dist/aizen-launcher.exe，其余平台输出 dist/aizen-launcher。
 * 仅受管安装的 Windows 端需要编译产物（安装脚本将其放置为 bin/aizen-assistant.exe）；
 * POSIX 端的 launcher 为安装脚本现场生成的 shell 脚本，不经过本构建。
 */

import { $ } from "bun"
import { join } from "node:path"
import { parseCliArgs } from "./parse-cli-args.ts"

async function main(): Promise<void> {
  const values = parseCliArgs(process.argv.slice(2), ["--target"])
  const target = values.target ?? "bun-windows-x64"
  const name = target.startsWith("bun-windows") ? "aizen-launcher.exe" : "aizen-launcher"
  await $`bun build --compile --target=${target} --outfile=${join("dist", name)} apps/launcher/main.ts`
  console.log(`launcher 构建完成：dist/${name}（target=${target}）`)
}

if (import.meta.main) await main()
