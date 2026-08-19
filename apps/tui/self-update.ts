/**
 * update 子命令：检查并安装最新版本（多版本布局）。
 *
 * 受管安装（github 通道）执行自更新：查询 GitHub API → 下载 → SHA256 校验 → 解压 →
 * 落位到 versions/v<版本>/ → 原子切换 install.json 的 current → 清理旧版本。
 * 新版本落位在独立版本目录，不触碰运行中的可执行文件，因此更新可以在实例运行中完成；
 * 启动入口始终是 bin/ 下的 launcher（读 install.json 的 current 指向版本目录）。
 * npm 通道（预留）与便携模式不做自更新，分别提示对应操作。
 */

import { basename, dirname, join } from "node:path"
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
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

/** POSIX launcher 脚本（与 install.sh 生成的脚本保持一致，供旧布局迁移与 launcher 更新复用）。 */
const POSIX_LAUNCHER_SCRIPT = `#!/usr/bin/env sh
# AizenAssistant launcher（由安装脚本生成，勿手动编辑）
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
INSTALL_ROOT="$(dirname -- "$SCRIPT_DIR")"
RECORD="$INSTALL_ROOT/install.json"
if [ ! -f "$RECORD" ]; then
  echo "错误：无法读取安装记录：$RECORD" >&2
  exit 1
fi
CURRENT="$(grep -o '"current"[[:space:]]*:[[:space:]]*"[^"]*"' "$RECORD" | head -1 | sed 's/.*"current"[[:space:]]*:[[:space:]]*"\\([^"]*\\)"/\\1/')"
if [ -z "$CURRENT" ]; then
  echo "错误：安装记录缺少 current 字段" >&2
  exit 1
fi
EXE="$INSTALL_ROOT/versions/$CURRENT/aizen-assistant"
if [ ! -x "$EXE" ]; then
  echo "错误：找不到可执行文件：$EXE" >&2
  exit 1
fi
# --data-dir 注入只是提供默认值：用户已显式传入时尊重用户选择；
# update / uninstall 分发子命令不使用数据目录，同样不注入。
INJECT=1
case "\${1:-}" in
  update|uninstall) INJECT=0 ;;
esac
if [ "$INJECT" -eq 1 ]; then
  for ARG in "$@"; do
    if [ "$ARG" = "--data-dir" ]; then INJECT=0; break; fi
  done
fi
if [ "$INJECT" -eq 1 ]; then
  exec "$EXE" --data-dir "$INSTALL_ROOT/data" "$@"
fi
exec "$EXE" "$@"
`

/** 比较语义化版本（x.y.z，可选预发布后缀如 -beta.1）：a 大于 b 返回正数，相等返回 0，否则负数。 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = "", pre = ""] = value.split("-", 2)
    const [major = 0, minor = 0, patch = 0] = core.split(".").map((part) => Number.parseInt(part, 10) || 0)
    return { major, minor, patch, pre: pre ? pre.split(".") : null }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (const key of ["major", "minor", "patch"] as const) {
    const diff = pa[key] - pb[key]
    if (diff !== 0) return diff
  }
  // 预发布优先级：无预发布 > 有预发布
  if (pa.pre === null && pb.pre !== null) return 1
  if (pa.pre !== null && pb.pre === null) return -1
  if (pa.pre !== null && pb.pre !== null) {
    // 逐个比较预发布标识符：数字按数值、字母按 ASCII；数字 < 字母；标识符少的更小
    const length = Math.max(pa.pre.length, pb.pre.length)
    for (let index = 0; index < length; index++) {
      const aId = pa.pre[index]
      const bId = pb.pre[index]
      if (aId === undefined) return -1
      if (bId === undefined) return 1
      const aNumeric = /^\d+$/.test(aId)
      const bNumeric = /^\d+$/.test(bId)
      if (aNumeric && bNumeric) {
        const diff = Number.parseInt(aId, 10) - Number.parseInt(bId, 10)
        if (diff !== 0) return diff
      } else if (aNumeric) {
        return -1
      } else if (bNumeric) {
        return 1
      } else if (aId !== bId) {
        return aId < bId ? -1 : 1
      }
    }
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

/** 安装根目录：真实可执行文件位于 <根>/versions/<current>/ 或旧布局 <根>/bin/，据此向上推导。 */
function installRoot(): string {
  const exeDir = dirname(process.execPath)
  return basename(dirname(exeDir)) === "versions" ? dirname(dirname(exeDir)) : dirname(exeDir)
}

/** 是否旧单文件布局：exe 位于 <根>/bin/ 且不存在 versions/ 目录。 */
function isLegacyLayout(): boolean {
  const exeDir = dirname(process.execPath)
  if (basename(exeDir) !== "bin") return false
  return !existsSync(join(dirname(exeDir), "versions"))
}

/** 移动数据目录内容（旧布局 bin/.aizen → 安装根 data/）；失败时保留旧目录、不阻塞更新。 */
async function moveDataDir(oldData: string, newData: string): Promise<void> {
  try {
    const entries = await readdir(oldData)
    if (entries.length === 0) {
      await rm(oldData, { recursive: true, force: true })
      return
    }
    await mkdir(newData, { recursive: true })
    for (const entry of entries) {
      await rename(join(oldData, entry), join(newData, entry))
    }
    await rm(oldData, { recursive: true, force: true })
  } catch {
    // 数据迁移失败（如跨卷）时保留旧目录，由后续流程或用户手动处理
  }
}

/**
 * 从旧单文件布局迁移到多版本布局（update 触发的路径）。
 * - Windows：运行中的 exe 被锁，复制自身到 versions/，launcher 经延迟脚本替换 bin/ 下旧 exe。
 * - POSIX：运行中的 exe 可重命名，直接移动自身并在 bin/ 下生成 launcher 脚本。
 */
async function migrateLegacyLayout(root: string, launcherSource?: string): Promise<void> {
  const exeDir = dirname(process.execPath)
  const exeName = basename(process.execPath)
  const record = await readInstallRecord()
  const oldVersion = record?.version ?? "legacy"
  const versionDir = join(root, "versions", `v${oldVersion}`)
  await mkdir(versionDir, { recursive: true })
  if (process.platform === "win32") {
    await copyFile(process.execPath, join(versionDir, exeName))
    await moveDataDir(join(exeDir, ".aizen"), join(root, "data"))
    if (launcherSource && (await Bun.file(launcherSource).exists())) {
      // 旧 exe 正被当前进程锁定，launcher 由独立进程在当前进程退出后落位
      const staged = join(root, `.launcher-staged-${process.pid}.exe`)
      await copyFile(launcherSource, staged)
      await scheduleDeferredPowerShell([
        "Start-Sleep -Seconds 1",
        `Copy-Item -Force ${quotedPowerShell(staged)} ${quotedPowerShell(join(exeDir, exeName))}`,
        `Remove-Item -Force ${quotedPowerShell(staged)} -ErrorAction SilentlyContinue`,
      ])
    }
  } else {
    await rename(process.execPath, join(versionDir, exeName))
    await moveDataDir(join(exeDir, ".aizen"), join(root, "data"))
    await writeFile(join(exeDir, exeName), POSIX_LAUNCHER_SCRIPT, { mode: 0o755 })
  }
  console.log(`旧版布局已迁移：versions/v${oldVersion} 与 ${join(root, "data")}`)
}

/** 用发布包内容更新 bin/ 下 launcher（Windows 取 launcher.exe，POSIX 重写脚本）；被锁时忽略、下次再试。 */
async function updateLauncher(root: string, packageDir: string): Promise<void> {
  const binDir = join(root, "bin")
  if (process.platform === "win32") {
    const source = join(packageDir, "launcher.exe")
    if (await Bun.file(source).exists()) {
      await copyFile(source, join(binDir, "aizen-assistant.exe")).catch(() => {})
    }
  } else {
    await writeFile(join(binDir, "aizen-assistant"), POSIX_LAUNCHER_SCRIPT, { mode: 0o755 })
  }
}

/** 清理 versions/ 下除 current 之外的历史版本（保留最近一个，供回滚；被运行中实例锁定时忽略）。 */
async function gcVersions(root: string, keepCurrent: string): Promise<void> {
  const versionsDir = join(root, "versions")
  let entries: string[]
  try {
    entries = await readdir(versionsDir)
  } catch {
    return
  }
  const others = entries
    .filter((name) => name.startsWith("v") && name !== keepCurrent)
    .sort((a, b) => compareVersions(a.replace(/^v/, ""), b.replace(/^v/, "")))
    .reverse()
  for (const extra of others.slice(1)) {
    await rm(join(versionsDir, extra), { recursive: true, force: true }).catch(() => {})
  }
}

/** 执行更新；releaseApi 可选（默认 GitHub，测试或自建镜像场景传入）；返回进程退出码。 */
export async function runUpdate(releaseApi?: string): Promise<number> {
  // 源码运行（bun 启动）下 process.execPath 是 bun 解释器，自更新无意义，明确拒绝
  if (basename(process.execPath).toLowerCase().startsWith("bun")) {
    console.error("源码运行（bun 启动）不支持 update，请使用安装脚本装出的分发版本。")
    return 1
  }
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
  try {
    const zipPath = join(workDir, assetName)
    await download(asset.url, zipPath)

    // 校验 SHA256：SHA256SUMS 资产或对应行缺失时一律视为校验失败，不允许静默降级
    const sumsAsset = release.assets.find((item) => item.name === "SHA256SUMS")
    if (!sumsAsset) {
      console.error("发布缺少 SHA256SUMS 资产，无法校验，已中止更新")
      return 1
    }
    const sumsResponse = await fetch(sumsAsset.url, { signal: AbortSignal.timeout(30_000) })
    if (!sumsResponse.ok) {
      console.error(`下载 SHA256SUMS 失败：HTTP ${sumsResponse.status}`)
      return 1
    }
    const sumsText = await sumsResponse.text()
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
    const extracted = join(workDir, "extracted")
    const packageExe = join(extracted, basename(process.execPath))
    if (!(await Bun.file(packageExe).exists())) throw new Error("压缩包内未找到可执行文件")

    const root = installRoot()
    // 旧单文件布局先迁移（bin/ 下真实可执行文件场景），迁移后 current 由下方切换
    if (isLegacyLayout()) {
      console.log("检测到旧版单文件布局，正在迁移...")
      await migrateLegacyLayout(root, join(extracted, "launcher.exe"))
    }

    // 新版本落位到 versions/v<版本>/（同卷临时名 + 原子 rename）
    const versionDir = join(root, "versions", `v${release.version}`)
    await mkdir(versionDir, { recursive: true })
    const target = join(versionDir, basename(process.execPath))
    const staged = join(versionDir, `.tmp-${process.pid}`)
    await copyFile(packageExe, staged)
    await rm(target, { force: true }).catch(() => {})
    await rename(staged, target)

    // 更新 bin/ 下 launcher（多版本布局已是 launcher；旧布局迁移场景由延迟脚本兜底）
    await updateLauncher(root, extracted)

    const successRecord: InstallRecord = {
      channel: "github",
      version: release.version,
      platform: record.platform,
      current: `v${release.version}`,
    }
    await writeInstallRecord(successRecord)
    await gcVersions(root, `v${release.version}`)

    console.log(`更新完成：${record.version} → ${release.version}`)
    return 0
  } catch (error) {
    console.error(`更新失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
