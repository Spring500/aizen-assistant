/**
 * update 子命令：检查并安装最新版本。
 *
 * 仅 github 通道执行自更新（查询 GitHub API → 下载 → SHA256 校验 → 替换自身）。
 * npm 通道（预留）与便携模式不做自更新，分别提示对应操作。
 */

import { basename, dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises"
import { $ } from "bun"
import {
  type InstallRecord,
  installRecordPath,
  readInstallRecord,
  writeInstallRecord,
} from "../../packages/core/install-record.ts"
import { quotedPowerShell, scheduleDeferredPowerShell } from "./deferred-powershell.ts"

/** 默认 GitHub API 基地址，用于查询最新 release；资产 URL 取自返回 JSON，无需额外配置。 */
const DEFAULT_RELEASE_API = "https://api.github.com/repos/Spring500/aizen-assistant"

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

/** 查询仓库最新 release；releaseApi 为 API 基地址（测试或自建镜像场景传入）。 */
async function fetchLatestRelease(releaseApi: string): Promise<LatestRelease> {
  const response = await fetch(`${releaseApi}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "aizen-assistant" },
    signal: AbortSignal.timeout(30_000),
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

/** 下载远程文件到本地路径（大文件给更长超时）。 */
async function download(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  await Bun.write(dest, response)
}

/** 解压 zip 到目标目录（Windows 用 PowerShell，其余平台用 unzip）。 */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  if (process.platform === "win32") {
    const script = `Expand-Archive -LiteralPath ${quotedPowerShell(zipPath)} -DestinationPath ${quotedPowerShell(destDir)} -Force`
    const proc = Bun.spawn({ cmd: ["powershell", "-NoProfile", "-Command", script] })
    const exitCode = await proc.exited
    if (exitCode !== 0) throw new Error("解压失败（Expand-Archive）")
  } else {
    await $`unzip -o ${zipPath} -d ${destDir}`
  }
}

/**
 * 用新可执行文件替换当前进程的可执行文件。
 * - Windows：运行中 exe 被锁，延迟替换；替换成功后由延迟脚本写 install.json（避免版本记录与实际 exe 不一致）。
 * - POSIX：rename 原子替换；跨文件系统（EXDEV）时先复制到目标同目录再 rename。
 * cleanupDir：Windows 延迟替换时由延迟脚本负责删除的临时目录（调用方不得提前删除其中的新文件）。
 * successRecord：Windows 下替换成功后写入的安装记录（channel/version/platform）。
 */
async function replaceExecutable(
  newExecutable: string,
  currentExecutable: string,
  cleanupDir?: string,
  successRecord?: InstallRecord,
): Promise<void> {
  if (process.platform === "win32") {
    const lines = [
      "Start-Sleep -Seconds 1",
      // 用 .NET 计算新文件哈希作为替换成功的基准（不依赖 PowerShell 模块自动加载）。
      // FileStream 必须显式 Dispose：OpenRead 默认 FileShare.Read，未关闭的流会阻止后续 Move-Item。
      "$sha = [System.Security.Cryptography.SHA256]::Create()",
      `$newStream = [System.IO.File]::OpenRead(${quotedPowerShell(newExecutable)})`,
      "try { $newHash = [System.BitConverter]::ToString($sha.ComputeHash($newStream)).Replace('-','').ToLower() } finally { $newStream.Dispose() }",
      `Remove-Item -Force ${quotedPowerShell(currentExecutable)}`,
      `Move-Item -Force ${quotedPowerShell(newExecutable)} ${quotedPowerShell(currentExecutable)}`,
      // Test-Path 无法区分目标处是新 exe 还是被锁残留的旧 exe，必须比较内容哈希一致才认为替换成功
      `if (-not [System.IO.File]::Exists(${quotedPowerShell(currentExecutable)})) { exit 1 }`,
      `$currentStream = [System.IO.File]::OpenRead(${quotedPowerShell(currentExecutable)})`,
      "try { $currentHash = [System.BitConverter]::ToString($sha.ComputeHash($currentStream)).Replace('-','').ToLower() } finally { $currentStream.Dispose() }",
      `if ($currentHash -ne $newHash) { exit 1 }`,
      ...(successRecord
        ? [
            `[System.IO.File]::WriteAllText(${quotedPowerShell(installRecordPath())}, ${quotedPowerShell(
              JSON.stringify(successRecord),
            )}, (New-Object System.Text.UTF8Encoding($false)))`,
          ]
        : []),
      ...(cleanupDir ? [`Remove-Item -Recurse -Force ${quotedPowerShell(cleanupDir)}`] : []),
    ]
    await scheduleDeferredPowerShell(lines)
  } else {
    try {
      await rename(newExecutable, currentExecutable)
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EXDEV") {
        // 跨文件系统：临时目录与安装目录不在同一挂载点（如 Linux /tmp 为 tmpfs），rename 抛 EXDEV。
        // 先复制到目标同目录（同卷）再 rename，保持同卷原子替换并保留可执行权限。
        const staged = join(dirname(currentExecutable), `.aizen-update-${process.pid}.tmp`)
        try {
          const mode = (await stat(newExecutable)).mode
          await copyFile(newExecutable, staged)
          await chmod(staged, mode)
          await rename(staged, currentExecutable)
        } finally {
          await rm(staged, { force: true })
        }
      } else {
        throw error
      }
    }
  }
}

/** 执行更新；releaseApi 可选（默认 GitHub，测试或自建镜像场景传入）；返回进程退出码。 */
export async function runUpdate(releaseApi?: string): Promise<number> {
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
    release = await fetchLatestRelease(releaseApi ?? DEFAULT_RELEASE_API)
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

    // 校验 SHA256：SHA256SUMS 资产或对应行缺失时一律视为校验失败，不允许静默降级
    const sumsAsset = release.assets.find((item) => item.name === "SHA256SUMS")
    if (!sumsAsset) {
      console.error("发布缺少 SHA256SUMS 资产，无法校验，已中止更新")
      return 1
    }
    const sumsText = await (await fetch(sumsAsset.url, { signal: AbortSignal.timeout(30_000) })).text()
    const line = sumsText.split(/\r?\n/).find((item) => item.trimEnd().endsWith(assetName))
    if (!line) {
      console.error(`SHA256SUMS 中找不到 ${assetName} 的校验和，已中止更新`)
      return 1
    }
    const expected = line.trim().split(/\s+/)[0]
    const actual = await sha256Of(zipPath)
    if (expected !== actual) {
      console.error("SHA256 校验失败，已中止更新")
      return 1
    }

    await extractZip(zipPath, join(workDir, "extracted"))
    const newExecutable = join(workDir, "extracted", basename(process.execPath))
    if (!(await Bun.file(newExecutable).exists())) throw new Error("压缩包内未找到可执行文件")

    const successRecord: InstallRecord = { channel: "github", version: release.version, platform: record.platform }
    await replaceExecutable(newExecutable, process.execPath, workDir, successRecord)
    delayReplaceScheduled = true
    // Windows 下 install.json 由延迟脚本在替换成功后写入（避免版本记录与实际 exe 不一致）；
    // POSIX 下 rename 已同步完成，这里直接写入。
    if (process.platform !== "win32") {
      await writeInstallRecord(successRecord)
    }
    console.log(`更新完成：${record.version} → ${release.version}`)
    return 0
  } catch (error) {
    console.error(`更新失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    if (!delayReplaceScheduled) await rm(workDir, { recursive: true, force: true })
  }
}
