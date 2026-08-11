/**
 * update 子命令：检查并安装最新版本。
 *
 * 仅 github 通道执行自更新（查询 GitHub API → 下载 → SHA256 校验 → 原子替换自身）。
 * npm 通道（预留）与便携模式不做自更新，分别提示对应操作。
 */

import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { $ } from "bun"
import { readInstallRecord, writeInstallRecord } from "../../packages/core/install-record.ts"

/**
 * GitHub API 基地址，用于查询最新 release。
 * 可用 AIZEN_RELEASE_API 环境变量覆盖（本地 mock 测试或自建镜像场景）；资产 URL 取自返回 JSON，无需单独覆盖。
 */
const releaseApiBase = process.env.AIZEN_RELEASE_API ?? "https://api.github.com/repos/Spring500/aizen-assistant"

/** 比较语义化版本 x.y.z：a 大于 b 返回正数，相等返回 0，否则负数。 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < 3; index++) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 计算文件的 SHA256（hex 小写）。 */
async function sha256Of(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest("hex")
}

/** GitHub release 的最新版本与资产清单。 */
type LatestRelease = {
  version: string
  assets: { name: string; url: string }[]
}

/** 查询仓库最新 release。 */
async function fetchLatestRelease(): Promise<LatestRelease> {
  const response = await fetch(`${releaseApiBase}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "aizen-assistant" },
  })
  if (!response.ok) throw new Error(`查询最新版本失败：HTTP ${response.status}`)
  const payload = (await response.json()) as {
    tag_name?: string
    assets?: { name: string; browser_download_url: string }[]
  }
  const tag = payload.tag_name ?? ""
  if (!tag.startsWith("v")) throw new Error("最新 release 的 tag 格式异常")
  return {
    version: tag.slice(1),
    assets: (payload.assets ?? []).map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
  }
}

/** 下载远程文件到本地路径。 */
async function download(url: string, dest: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  await Bun.write(dest, response)
}

/** 解压 zip 到目标目录（Windows 用 PowerShell，其余平台用 unzip）。 */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  if (process.platform === "win32") {
    const script = `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`
    const proc = Bun.spawn({ cmd: ["powershell", "-NoProfile", "-Command", script] })
    const exitCode = await proc.exited
    if (exitCode !== 0) throw new Error("解压失败（Expand-Archive）")
  } else {
    await $`unzip -o ${zipPath} -d ${destDir}`
  }
}

/**
 * 用新可执行文件替换当前进程的可执行文件；Windows 下运行中 exe 被锁，延迟替换。
 * cleanupDir：Windows 延迟替换时由延迟脚本负责删除的临时目录（调用方不得提前删除其中的新文件）。
 */
async function replaceExecutable(newExecutable: string, currentExecutable: string, cleanupDir?: string): Promise<void> {
  if (process.platform === "win32") {
    // 写临时 ps1，由 Start-Process 启动独立 PowerShell 在进程退出后执行（Bun.spawn 子进程会随父退出被终止）。
    const script = join(tmpdir(), `aizen-update-${Date.now()}.ps1`)
    const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`
    await writeFile(
      script,
      [
        "Start-Sleep -Seconds 1",
        `Remove-Item -Force ${quoted(currentExecutable)}`,
        `Move-Item -Force ${quoted(newExecutable)} ${quoted(currentExecutable)}`,
        ...(cleanupDir ? [`Remove-Item -Recurse -Force ${quoted(cleanupDir)}`] : []),
        `Remove-Item -Force ${quoted(script)}`,
        "",
      ].join("\n"),
    )
    const launch = `Start-Process -WindowStyle Hidden powershell -ArgumentList ${[
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
    ]
      .map((value) => `'${value.replaceAll("'", "''")}'`)
      .join(",")}`
    await Bun.spawn({ cmd: ["powershell", "-NoProfile", "-Command", launch], stdout: "ignore", stderr: "ignore" })
      .exited
  } else {
    await rename(newExecutable, currentExecutable)
  }
}

/** 执行更新；返回进程退出码。 */
export async function runUpdate(): Promise<number> {
  if (process.env.AIZEN_MANAGED_BY === "npm") {
    console.log("npm 通道安装：运行 `npm update -g aizen-assistant` 即可更新，launcher 会自动更新二进制。")
    return 0
  }
  const record = await readInstallRecord()
  if (!record) {
    console.error("便携模式（未检测到安装记录）：无法自动更新，请从 GitHub Releases 手动下载新版替换。")
    return 1
  }
  if (record.channel !== "github") {
    console.log("当前通道无需自更新，请按对应安装方式更新。")
    return 0
  }

  let release: LatestRelease
  try {
    release = await fetchLatestRelease()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  if (compareVersions(release.version, record.version) <= 0) {
    console.log(`已是最新版本：${record.version}`)
    return 0
  }

  const assetName = `aizen-assistant-${release.version}-${record.platform}.zip`
  const asset = release.assets.find((item) => item.name === assetName)
  if (!asset) {
    console.error(`发布中找不到当前平台（${record.platform}）的资产：${assetName}`)
    return 1
  }

  const workDir = await mkdtemp(join(tmpdir(), "aizen-update-"))
  // Windows 下已调度延迟替换时，workDir 由延迟脚本清理，主流程不得提前删除（否则新文件丢失）。
  let delayReplaceScheduled = false
  try {
    const zipPath = join(workDir, assetName)
    await download(asset.url, zipPath)

    // 校验 SHA256（与 Release 资产的 SHA256SUMS 比对）
    const sumsAsset = release.assets.find((item) => item.name === "SHA256SUMS")
    if (sumsAsset) {
      const sumsText = await (await fetch(sumsAsset.url)).text()
      const line = sumsText.split(/\r?\n/).find((item) => item.trimEnd().endsWith(assetName))
      if (line) {
        const expected = line.trim().split(/\s+/)[0]
        const actual = await sha256Of(zipPath)
        if (expected !== actual) {
          console.error("SHA256 校验失败，已中止更新")
          return 1
        }
      }
    }

    await extractZip(zipPath, join(workDir, "extracted"))
    const newExecutable = join(workDir, "extracted", basename(process.execPath))
    if (!(await Bun.file(newExecutable).exists())) throw new Error("压缩包内未找到可执行文件")

    await replaceExecutable(newExecutable, process.execPath, workDir)
    delayReplaceScheduled = true
    await writeInstallRecord({ channel: "github", version: release.version, platform: record.platform })
    console.log(`更新完成：${record.version} → ${release.version}`)
    return 0
  } catch (error) {
    console.error(`更新失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    if (!delayReplaceScheduled) await rm(workDir, { recursive: true, force: true })
  }
}
