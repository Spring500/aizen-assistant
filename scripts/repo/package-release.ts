/**
 * 发布打包：把单个平台构建产物连同版本文件打成 zip，供 release workflow 上传。
 *
 * 用法：
 *   bun run scripts/repo/package-release.ts --version 0.1.0 --platform windows-x64
 *
 * 输入：dist/aizen-assistant[.exe]（由 build:tui 按平台生成）
 * 输出：dist/aizen-assistant-<version>-<platform>.zip
 * 压缩包内容：可执行文件 + version 文件（供安装脚本写 install.json，不依赖 zip 名解析）。
 */

import { $ } from "bun"
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseCliArgs } from "./parse-cli-args.ts"

/** 根据平台标识推断压缩包内可执行文件名（Windows 带 .exe 后缀）。 */
function executableName(platform: string): string {
  return platform.startsWith("windows") ? "aizen-assistant.exe" : "aizen-assistant"
}

/** 生成 zip（Windows 用 PowerShell Compress-Archive，其余平台用 zip 命令）。 */
async function createZip(stagingDir: string, zipPath: string): Promise<void> {
  if (process.platform === "win32") {
    const script = `Compress-Archive -Path '${join(stagingDir, "*")}' -DestinationPath '${zipPath}' -Force`
    const proc = Bun.spawn({ cmd: ["powershell", "-NoProfile", "-Command", script] })
    const exitCode = await proc.exited
    if (exitCode !== 0) throw new Error("压缩失败（Compress-Archive）")
  } else {
    await $`cd ${stagingDir} && zip -qr ${zipPath} .`
  }
}

async function main(): Promise<void> {
  const values = parseCliArgs(process.argv.slice(2), ["--version", "--platform"])
  const version = values.version
  const platform = values["platform"]
  if (!version || !platform) throw new Error("必须提供 --version 与 --platform")
  const name = executableName(platform)
  const stagingDir = join("dist", "staging")
  const zipPath = join("dist", `aizen-assistant-${version}-${platform}.zip`)

  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })
  await copyFile(join("dist", name), join(stagingDir, name))
  await writeFile(join(stagingDir, "version"), `${version}\n`)
  await createZip(stagingDir, zipPath)
  await rm(stagingDir, { recursive: true, force: true })

  console.log(`打包完成：${zipPath}`)
}

if (import.meta.main) await main()
