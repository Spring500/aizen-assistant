/**
 * 本地 mock GitHub Release 服务器，供发布链路端到端测试使用。
 *
 * 用法：
 *   bun run scripts/repo/mock-release-server.ts --assets-dir <目录> --version 0.1.0 --port 18081
 *
 * 提供两个端点：
 *   GET /releases/latest             返回 { tag_name: "v<version>", assets: [...] }（与 GitHub API 形状一致）
 *   GET /download/<version>/<文件>    返回资产目录中的静态文件
 *
 * 配合 AIZEN_RELEASE_API / AIZEN_RELEASE_DOWNLOAD 环境变量即可让 install 脚本与 update 命令脱离 GitHub 运行。
 */

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { parseCliArgs } from "./parse-cli-args.ts"

async function main(): Promise<void> {
  const values = parseCliArgs(process.argv.slice(2), ["--assets-dir", "--version", "--port"])
  const assetsDir = values["assets-dir"]
  const version = values.version
  const port = Number.parseInt(values.port ?? "18081", 10)
  if (!assetsDir || !version) throw new Error("必须提供 --assets-dir 与 --version")
  if (!Number.isInteger(port)) throw new Error("--port 必须是整数")
  // 与真实 GitHub Releases 下载路径保持一致：/download/v<version>/<文件>
  const downloadPrefix = `/download/v${version}/`

  const server = Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/releases/latest") {
        const files = await readdir(assetsDir)
        const assets = files.map((name) => ({
          name,
          browser_download_url: `http://localhost:${port}${downloadPrefix}${encodeURIComponent(name)}`,
        }))
        return Response.json({ tag_name: `v${version}`, assets })
      }
      if (url.pathname.startsWith(downloadPrefix)) {
        const name = decodeURIComponent(url.pathname.slice(downloadPrefix.length))
        const file = Bun.file(join(assetsDir, name))
        if (await file.exists()) return new Response(file)
        return new Response("Not Found", { status: 404 })
      }
      return new Response("Not Found", { status: 404 })
    },
  })

  console.log(`mock release 服务器已启动：http://localhost:${port}（latest=v${version}，资产目录=${assetsDir}）`)
  // 保持进程运行；由调用方（端到端测试）负责终止。
  process.on("SIGTERM", () => {
    server.stop(true)
    process.exit(0)
  })
  process.on("SIGINT", () => {
    server.stop(true)
    process.exit(0)
  })
}

if (import.meta.main) await main()
