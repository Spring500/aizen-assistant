/**
 * uninstall 子命令：删除受管安装并回滚 PATH。
 *
 * 行为：确认（--yes 跳过）→ 读 install.json → 回滚 PATH → 删除 ~/.aizen。
 * Windows 下运行中的 exe 无法删除，通过临时 PowerShell 脚本延迟删除自身与 bin 目录。
 */

import { homedir } from "node:os"
import { readFile, writeFile, rm, readdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { installRecordPath, readInstallRecord } from "../../packages/core/install-record.ts"
import { quotedPowerShell, scheduleDeferredPowerShell } from "./deferred-powershell.ts"

/**
 * Windows 用户级 PATH 中指向安装目录的条目（install.ps1 写入的字面形式，两侧必须保持一致）。
 * 卸载时同时移除该字面条目与 $HOME 展开的绝对形式（防御用户手动改动过 PATH）。
 */
const WINDOWS_PATH_ENTRY = "%USERPROFILE%\\.aizen\\bin"

/**
 * 安装脚本写入 shell 配置的精确 PATH 行（与 install.sh 的 append_path_line 保持一致）。
 * 卸载仅删除这些精确行，避免误删用户自行配置的含 .aizen/bin 子串的其他条目。
 */
const INSTALLED_PATH_LINES = ['export PATH="$HOME/.aizen/bin:$PATH"', "fish_add_path $HOME/.aizen/bin"]

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

/** 从 bash/zsh/fish 配置中移除指向 ~/.aizen/bin 的 PATH 行（幂等重写）。 */
async function removeShellPathEntries(home: string): Promise<void> {
  const candidates = [join(home, ".bashrc"), join(home, ".zshrc"), join(home, ".config", "fish", "config.fish")]
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
    const kept = lines.filter((line) => !INSTALLED_PATH_LINES.some((installed) => line.includes(installed)))
    if (kept.length === lines.length) continue
    await writeFile(file, `${kept.join("\n")}\n`)
    console.log(`已从 ${file} 移除 PATH 条目`)
  }
}

/** 从用户级 PATH 移除安装目录条目（经 PowerShell 操作 HKCU\Environment，免管理员）。 */
async function removeWindowsPathEntry(): Promise<void> {
  const binDir = dirname(process.execPath)
  const quotedBinDir = binDir.replaceAll("'", "''")
  const script = [
    "$entry2 = Join-Path $HOME '.aizen\\bin'",
    // 当前安装目录的绝对路径（覆盖 --install-dir 自定义安装场景写入的条目）
    `$entry3 = '${quotedBinDir}'`,
    "$current = [Environment]::GetEnvironmentVariable('Path','User')",
    "if ($null -eq $current) { exit 0 }",
    `$parts = $current -split ';' | Where-Object { $_.Trim() -ne '' -and $_.Trim() -ne '${WINDOWS_PATH_ENTRY}' -and $_.Trim() -ne $entry2 -and $_.Trim() -ne $entry3 }`,
    "$new = $parts -join ';'",
    "[Environment]::SetEnvironmentVariable('Path',$new,'User')",
  ].join("; ")
  const proc = Bun.spawn({ cmd: ["powershell", "-NoProfile", "-Command", script] })
  const exitCode = await proc.exited
  if (exitCode !== 0) console.error("回滚用户 PATH 失败，请手动检查 HKCU\\Environment")
  else console.log("已从用户 PATH 移除安装目录")
}

/** 删除数据与安装记录；目录由可执行文件位置推导（exe 位于 <安装根>/bin/），支持自定义安装目录。 */
async function removeAizenDirectory(): Promise<void> {
  const binDir = dirname(process.execPath)
  const aizenDir = dirname(binDir)
  await rm(join(binDir, "data"), { recursive: true, force: true })
  await rm(installRecordPath(), { force: true })

  if (process.platform === "win32") {
    // 删除 bin 下除安装的可执行文件之外的内容（安装的 exe 正被系统锁定，交给延迟脚本删除）。
    // 用固定文件名而非 process.execPath 判断，避免源码运行（bun 启动）时语义失配。
    const managedExecutableName = "aizen-assistant.exe"
    try {
      const entries = await readdir(binDir)
      for (const entry of entries) {
        const full = join(binDir, entry)
        if (basename(full) !== managedExecutableName) await rm(full, { recursive: true, force: true })
      }
    } catch {
      // bin 目录不存在时跳过
    }
    // 延迟删除自身 exe 与整个 ~/.aizen：由共享调度器在进程退出后执行（Bun.spawn 子进程会随父退出被终止）。
    await scheduleDeferredPowerShell([
      "Start-Sleep -Seconds 1",
      `Remove-Item -Recurse -Force ${quotedPowerShell(binDir)}`,
      `Remove-Item -Recurse -Force ${quotedPowerShell(aizenDir)}`,
    ])
  } else {
    // POSIX 允许删除运行中的可执行文件，整个目录一并删除
    await rm(aizenDir, { recursive: true, force: true })
  }
}

/** 执行卸载；返回进程退出码。 */
export async function runUninstall(skipConfirmation: boolean): Promise<number> {
  const home = homedir()
  const record = await readInstallRecord()
  if (!record) {
    console.error("未检测到受管安装（~/.aizen/install.json 不存在）。")
    console.error("若为便携模式，直接删除可执行文件及同目录 data 目录即可，无需执行卸载。")
    return 1
  }
  if (!(await confirmUninstall(skipConfirmation))) {
    console.log("已取消卸载")
    return 0
  }
  console.log(`卸载来源：${record.channel} ${record.version}（${record.platform}）`)
  if (process.platform === "win32") await removeWindowsPathEntry()
  else await removeShellPathEntries(home)
  await removeAizenDirectory()
  console.log("卸载完成：~/.aizen 已删除，PATH 已回滚")
  return 0
}
