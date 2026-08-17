/**
 * uninstall 子命令：删除受管安装并回滚 PATH。
 *
 * 行为：确认（--yes 跳过）→ 读 install.json → 回滚 PATH → 删除 ~/.aizen。
 * Windows 下运行中的 exe 无法删除，通过临时 PowerShell 脚本延迟删除自身与 bin 目录。
 */

import { homedir } from "node:os"
import { readFile, writeFile, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { installRecordPath, readInstallRecord } from "../../packages/core/install-record.ts"
import { quotedPowerShell, scheduleDeferredPowerShell } from "./deferred-powershell.ts"

/**
 * 安装脚本写入 shell 配置的精确 PATH 行（与 install.sh 的 append_path_line 保持一致）。
 * 卸载仅删除这些精确行，避免误删用户自行配置的含 .aizen/bin 子串的其他条目。
 */
const INSTALLED_PATH_LINES = ['export PATH="$HOME/.aizen/bin:$PATH"', "fish_add_path $HOME/.aizen/bin"]

/** 从 shell 配置行中过滤掉安装 PATH 行；installBinDir 为安装目录绝对路径（覆盖手写绝对路径条目）。 */
export function filterInstalledPathLines(lines: string[], installBinDir: string): string[] {
  return lines.filter(
    (line) => !INSTALLED_PATH_LINES.some((installed) => line.includes(installed)) && !line.includes(installBinDir),
  )
}

/** 交互确认卸载；非交互终端必须显式 --yes。 */
async function confirmUninstall(skipConfirmation: boolean): Promise<boolean> {
  if (skipConfirmation) return true
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("非交互终端下卸载需要显式确认：aizen-assistant uninstall --yes")
    return false
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>((resolve) => {
    readline.question("确认卸载？将删除 ~/.aizen 目录（含全部数据）并回滚 PATH [y/N] ", resolve)
  })
  readline.close()
  return answer.trim().toLowerCase() === "y"
}

/** 安装根：真身在多版本布局下位于 <根>/versions/<current>/，旧布局位于 <根>/bin/。 */
function installRootFromExecutable(): string {
  const exeDir = dirname(process.execPath)
  return basename(dirname(exeDir)) === "versions" ? dirname(dirname(exeDir)) : dirname(exeDir)
}

/** 从 bash/zsh/fish 配置中移除安装目录相关的 PATH 行（幂等重写）。 */
async function removeShellPathEntries(home: string): Promise<void> {
  // 安装目录 = 安装根/bin（多版本布局下真身在 versions/，不能直接用 dirname(execPath)）
  const installBinDir = join(installRootFromExecutable(), "bin")
  // 覆盖 install.sh 的 bash 分支写入的 .bashrc 与 .bash_profile（macOS 登录 shell 读 .bash_profile）
  const candidates = [
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".zshrc"),
    join(home, ".config", "fish", "config.fish"),
  ]
  for (const file of candidates) {
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue
      console.error(`无法读取 ${file}：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const lines = text.split(/\r?\n/)
    const kept = filterInstalledPathLines(lines, installBinDir)
    if (kept.length === lines.length) continue
    await writeFile(file, `${kept.join("\n")}\n`)
    console.log(`已从 ${file} 移除 PATH 条目`)
  }
}

/** 从用户级 PATH 移除安装目录条目（经 PowerShell 操作 HKCU\Environment，免管理员）。 */
async function removeWindowsPathEntry(): Promise<void> {
  const binDir = join(installRootFromExecutable(), "bin")
  const quotedBinDir = binDir.replaceAll("'", "''")
  const script = [
    // 默认安装路径的展开绝对形式（install.ps1 写入 $InstallDir）；install.ps1 已不再写 %USERPROFILE% 字面
    "$entry2 = Join-Path $HOME '.aizen\\bin'",
    // 当前安装目录的绝对路径（覆盖 --install-dir 自定义安装场景写入的条目）
    `$entry3 = '${quotedBinDir}'`,
    "$current = [Environment]::GetEnvironmentVariable('Path','User')",
    "if ($null -eq $current) { exit 0 }",
    `$parts = $current -split ';' | Where-Object { $_.Trim() -ne '' -and $_.Trim() -ne $entry2 -and $_.Trim() -ne $entry3 }`,
    "$new = $parts -join ';'",
    "[Environment]::SetEnvironmentVariable('Path',$new,'User')",
  ].join("; ")
  const proc = Bun.spawn({ cmd: ["powershell", "-NoProfile", "-Command", script] })
  const exitCode = await proc.exited
  if (exitCode !== 0) console.error("回滚用户 PATH 失败，请手动检查 HKCU\\Environment")
  else console.log("已从用户 PATH 移除安装目录")
}

/** 删除数据与安装记录；安装根由可执行文件位置推导（多版本布局为 <根>/versions/<current>/，旧布局为 <根>/bin/），支持自定义安装目录。 */
async function removeAizenDirectory(): Promise<void> {
  const root = installRootFromExecutable()
  await rm(installRecordPath(), { force: true })

  if (process.platform === "win32") {
    // 运行中的 exe 与数据目录可能被系统锁定，整个安装根交给延迟脚本在进程退出后删除
    // （Bun.spawn 子进程会随父退出被终止，须经 Start-Process 创建独立进程）。
    await scheduleDeferredPowerShell([
      "Start-Sleep -Seconds 1",
      `Remove-Item -Recurse -Force ${quotedPowerShell(root)}`,
    ])
  } else {
    // POSIX 允许删除运行中的可执行文件，整个安装根一并删除
    await rm(root, { recursive: true, force: true })
  }
}

/** 执行卸载；skipPath 跳过 PATH 回滚（测试/无副作用场景）；返回进程退出码。 */
export async function runUninstall(skipConfirmation: boolean, skipPath = false): Promise<number> {
  // 源码运行（bun 启动）下 process.execPath 是 bun 解释器，卸载无意义，明确拒绝
  if (basename(process.execPath).toLowerCase().startsWith("bun")) {
    console.error("源码运行（bun 启动）不支持 uninstall，请使用安装脚本装出的分发版本。")
    return 1
  }
  const home = homedir()
  const record = await readInstallRecord()
  if (!record) {
    console.error("未检测到受管安装（~/.aizen/install.json 不存在）。")
    console.error("若为便携模式，直接删除可执行文件及同目录 .aizen 目录即可，无需执行卸载。")
    return 1
  }
  if (!(await confirmUninstall(skipConfirmation))) {
    console.log("已取消卸载")
    return 0
  }
  console.log(`卸载来源：${record.channel} ${record.version}（${record.platform}）`)
  if (!skipPath) {
    if (process.platform === "win32") await removeWindowsPathEntry()
    else await removeShellPathEntries(home)
  }
  await removeAizenDirectory()
  console.log(`卸载完成：~/.aizen 已删除${skipPath ? "（--skip-path，未触碰 PATH）" : "，PATH 已回滚"}`)
  return 0
}
