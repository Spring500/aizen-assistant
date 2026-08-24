/**
 * 本地 mock GitHub Release 服务器，供发布链路端到端测试使用。
 *
 * 用法：
 *   bun run scripts/repo/mock-release-server.ts --assets-dir <目录> --version 0.1.0 --port 18081 [--draft]
 *
 * 提供五个端点（覆盖 GitHub 网页与 API 形状）：
 *   GET /Spring500/aizen-assistant/releases/latest   最新正式发布网页入口，重定向至 tag 页面
 *   GET /Spring500/aizen-assistant/releases/tag/...  重定向目标页
 *   GET /releases/latest             最新正式发布 API；--draft 时返回 404
 *   GET /releases                    发布列表（含 Draft；供 token 模式与 --pre 查询）
 *   GET /releases/assets/<id>        鉴权资产下载（需 Authorization 头；模拟 Draft 资产无匿名通道）
 *   GET /download/<version>/<文件>    匿名静态下载（对应 browser_download_url）
 *
 * 配合 install 脚本的 --latest-url / --api-url / --download-url 参数与 update 的 --release-api 参数即可脱离 GitHub 运行。
 */

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { parseCliArgs } from "./parse-cli-args.ts"

async function main(): Promise<void> {
  const values = parseCliArgs(process.argv.slice(2), ["--assets-dir", "--version", "--port"])
  const assetsDir = values["assets-dir"]
  const version = values.version
  const port = Number.parseInt(values.port ?? "18081", 10)
  // --draft：模拟预发布 Draft（latest 不可见，资产仅鉴权通道可下）
  const draft = process.argv.includes("--draft")
  if (!assetsDir || !version) throw new Error("必须提供 --assets-dir 与 --version")
  if (!Number.isInteger(port)) throw new Error("--port 必须是整数")
  // 与真实 GitHub Releases 下载路径保持一致：/download/v<version>/<文件>
  const downloadPrefix = `/download/v${version}/`

  /** 枚举资产目录，生成与 GitHub API 形状一致的资产列表（id 为文件序号，供鉴权资产端点寻址）。 */
  async function listAssets() {
    const files = (await readdir(assetsDir as string)).sort()
    return files.map((name, index) => ({
      id: index + 1,
      name,
      browser_download_url: `http://localhost:${port}${downloadPrefix}${encodeURIComponent(name)}`,
    }))
  }

  const server = Bun.serve({
    port,
    // 大文件（单文件可执行压缩包可达上百 MB）下载易触发默认 10s 空闲超时，调大供本地与 CI 使用。
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/Spring500/aizen-assistant/releases/latest") {
        if (draft) return new Response("Not Found", { status: 404 })
        return Response.redirect(`http://localhost:${port}/Spring500/aizen-assistant/releases/tag/v${version}`, 302)
      }
      if (url.pathname === `/Spring500/aizen-assistant/releases/tag/v${version}`) {
        if (draft) return new Response("Not Found", { status: 404 })
        return new Response("mock release page", { headers: { "Content-Type": "text/html" } })
      }
      if (url.pathname === "/releases/latest") {
        // GitHub 的 releases/latest 不包含 Draft 与 Prerelease
        if (draft) return new Response("Not Found", { status: 404 })
        return Response.json({ tag_name: `v${version}`, draft: false, prerelease: false, assets: await listAssets() })
      }
      if (url.pathname === "/releases") {
        return Response.json([{ tag_name: `v${version}`, draft, prerelease: draft, assets: await listAssets() }])
      }
      // 鉴权资产下载：模拟 Draft 资产只能经 token 通道获取（无 Authorization 头拒绝）
      const assetMatch = url.pathname.match(/^\/releases\/assets\/(\d+)$/)
      if (assetMatch?.[1]) {
        if (!request.headers.get("authorization")) return new Response("Unauthorized", { status: 401 })
        const assets = await listAssets()
        const asset = assets.find((item) => item.id === Number.parseInt(assetMatch[1] as string, 10))
        if (!asset) return new Response("Not Found", { status: 404 })
        const file = Bun.file(join(assetsDir, asset.name))
        if (await file.exists()) return new Response(file)
        return new Response("Not Found", { status: 404 })
      }
      if (url.pathname.startsWith(downloadPrefix)) {
        // Draft 资产无匿名下载通道（与 GitHub 行为一致）
        if (draft) return new Response("Not Found", { status: 404 })
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
