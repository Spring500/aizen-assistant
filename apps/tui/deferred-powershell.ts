/**
 * Windows 延迟 PowerShell 调度：把脚本行写入临时 ps1，由 Start-Process 启动独立 PowerShell 执行。
 *
 * 用途：运行中的 exe 被 Windows 锁定，无法立即删除/替换，需要在当前进程退出后再操作。
 * 不能用 Bun.spawn 直接跑延迟脚本（其子进程随父进程退出被终止），须经 Start-Process 创建独立进程。
 */

import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** 把字符串转为 PowerShell 单引号字面量（转义内部单引号），供拼接到 ps1 命令文本。 */
export function quotedPowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * 调度延迟执行：写入临时 ps1（含统一清理自身），由 Start-Process 启动独立 PowerShell 后立即返回。
 * scriptLines：延迟执行的 PowerShell 语句（不含删除脚本自身，由本函数统一处理）。
 */
export async function scheduleDeferredPowerShell(scriptLines: string[]): Promise<void> {
  const script = join(tmpdir(), `aizen-deferred-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`)
  await writeFile(script, [...scriptLines, `Remove-Item -Force ${quotedPowerShell(script)}`, ""].join("\n"))
  const launch = `Start-Process -WindowStyle Hidden powershell -ArgumentList ${[
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
  ]
    .map(quotedPowerShell)
    .join(",")}`
  const launcher = Bun.spawn({ cmd: ["powershell", "-NoProfile", "-Command", launch], stdout: "pipe", stderr: "pipe" })
  const exitCode = await launcher.exited
  if (exitCode !== 0) {
    const stderr = await new Response(launcher.stderr).text()
    throw new Error(`启动延迟 PowerShell 失败：exit=${exitCode}${stderr ? `；${stderr.trim()}` : ""}`)
  }
}
