/**
 * 参数化构建 launcher（Go），供 CI 发布矩阵复用。
 *
 * 用法：
 *   bun run build:launcher                       # 默认 target=bun-windows-x64
 *   bun run build:launcher --target bun-linux-x64
 *
 * 产物命名：Windows 平台输出 dist/aizen-launcher.exe，其余平台输出 dist/aizen-launcher。
 * 全平台均需编译产物（安装脚本将其放置为 bin/ 下的启动入口）；
 * 交叉编译由 Go 工具链原生支持，不依赖目标平台环境。
 */

import { $ } from "bun"
import { join } from "node:path"
import { parseCliArgs } from "./parse-cli-args.ts"

/** bun target（如 bun-windows-x64）到 Go 的 GOOS/GOARCH 映射。 */
const TARGET_MAP: Record<string, { goos: string; goarch: string }> = {
  "bun-windows-x64": { goos: "windows", goarch: "amd64" },
  "bun-windows-arm64": { goos: "windows", goarch: "arm64" },
  "bun-linux-x64": { goos: "linux", goarch: "amd64" },
  "bun-linux-arm64": { goos: "linux", goarch: "arm64" },
  "bun-darwin-arm64": { goos: "darwin", goarch: "arm64" },
}

async function main(): Promise<void> {
  const values = parseCliArgs(process.argv.slice(2), ["--target"])
  const target = values.target ?? "bun-windows-x64"
  const mapped = TARGET_MAP[target]
  if (!mapped) throw new Error(`不支持的 target：${target}`)
  const name = mapped.goos === "windows" ? "aizen-launcher.exe" : "aizen-launcher"
  await $`cd launcher && GOOS=${mapped.goos} GOARCH=${mapped.goarch} go build -o ${join("..", "dist", name)} .`
  console.log(`launcher 构建完成：dist/${name}（GOOS=${mapped.goos} GOARCH=${mapped.goarch}）`)
}

if (import.meta.main) await main()
