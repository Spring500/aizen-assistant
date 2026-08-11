/**
 * uninstall 子命令：删除受管安装并回滚 PATH。
 *
 * 行为：确认（--yes 跳过）→ 读 install.json → 回滚 PATH → 删除 ~/.aizen。
 * Windows 下运行中的 exe 无法删除，通过临时 PowerShell 脚本延迟删除自身与 bin 目录。
 */

import { homedir } from "node:os"
import { tmpdir } from "node:os"
import { readFile, writeFile, rm, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { createInterface } from "node:readline"
import { installRecordPath, readInstallRecord } from "../../packages/core/install-record.ts"

/** 用户级 PATH 中指向安装目录的条目（Windows 安装脚本写入的字面形式）。 */
const WINDOWS_PATH_ENTRY = "%USERPROFILE%\\.aizen\\bin"

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
    const kept = lines.filter((line) => !line.includes(".aizen/bin"))
    if (kept.length === lines.length) continue
    await writeFile(file, `${kept.join("\n")}\n`)
    console.log(`已从 ${file} 移除 PATH 条目`)
  }
}

/** 从用户级 PATH 移除安装目录条目（经 PowerShell 操作 HKCU\Environment，免管理员）。 */
async function removeWindowsPathEntry(): Promise<void> {
  const script = [
    "$entry2 = Join-Path $HOME '.aizen\\bin'",
    "$current = [Environment]::GetEnvironmentVariable('Path','User')",
    "if ($null -eq $current) { exit 0 }",
    `$parts = $current -split ';' | Where-Object { $_.Trim() -ne '' -and $_.Trim() -ne '${WINDOWS_PATH_ENTRY}' -and $_.Trim() -ne $entry2 }`,
    "$new = $parts -join ';'",
    "[Environment]::SetEnvironmentVariable('Path',$new,'User')",
  ].join("; ")
  const proc = Bun.spawn({ cmd: ["powershell", "-NoProfile", "-Command", script] })
  const exitCode = await proc.exited
  if (exitCode !== 0) console.error("回滚用户 PATH 失败，请手动检查 HKCU\\Environment")
  else console.log("已从用户 PATH 移除安装目录")
}

/** 删除数据与安装记录；Windows 上自身 exe 延迟删除。 */
async function removeAizenDirectory(home: string, executablePath: string): Promise<void> {
  const aizenDir = join(home, ".aizen")
  const binDir = join(aizenDir, "bin")
  await rm(join(aizenDir, "data"), { recursive: true, force: true })
  await rm(installRecordPath(), { force: true })

  if (process.platform === "win32") {
    // 删除 bin 下非自身文件（自身 exe 被系统锁定）
    try {
      const entries = await readdir(binDir)
      for (const entry of entries) {
        const full = join(binDir, entry)
        if (basename(full) !== basename(executablePath)) await rm(full, { recursive: true, force: true })
      }
    } catch {
      // bin 目录不存在时跳过
    }
    // 延迟删除自身 exe 与 bin 目录：写临时 ps1 并由独立 PowerShell 进程在进程退出后执行
    const script = join(tmpdir(), `aizen-uninstall-${Date.now()}.ps1`)
    const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`
    await writeFile(
      script,
      `Start-Sleep -Seconds 1\nRemove-Item -Recurse -Force ${quoted(binDir)}\nRemove-Item -Force ${quoted(script)}\n`,
    )
    Bun.spawn({
      cmd: ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      stdout: "ignore",
      stderr: "ignore",
    })
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
  await removeAizenDirectory(home, process.execPath)
  console.log("卸载完成：~/.aizen 已删除，PATH 已回滚")
  return 0
}
