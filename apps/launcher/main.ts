/**
 * AizenAssistant launcher（受管安装的启动入口）。
 *
 * 职责：读取 install.json 的 current 版本目录 → 启动 versions/<current>/ 下的真实可执行文件，
 * 并透传 stdio 与退出码；仅交互模式注入 --data-dir（update / uninstall 分发子命令不使用数据目录）。
 *
 * 设计约束：
 * - 只服务受管安装（install.json 存在且含 current）；便携模式不经过 launcher，直接运行真实可执行文件。
 * - 逻辑刻意保持极简稳定：只做"定位 + 启动 + 透传"，不承担版本检查、下载、清理等职责，
 *   以保证 launcher 自身几乎不需要随主程序更新。
 */

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/** 启动计划：真实可执行文件、注入的数据目录与透传参数。 */
export type LaunchPlan = {
  executable: string
  dataDirectory: string
  args: string[]
}

/** 是否注入 --data-dir：仅交互模式使用数据目录；update / uninstall 分发子命令不使用，launcher 不注入。 */
export function shouldInjectDataDir(args: string[]): boolean {
  return args[0] !== "update" && args[0] !== "uninstall"
}

/**
 * 根据安装根与安装记录计算启动目标。
 * installRoot：安装根目录（install.json 所在目录）；record：安装记录（至少含 current）。
 * platform：目标平台（win32 决定可执行文件名后缀）；args：透传给真实可执行文件的原始参数。
 * 缺少或非法的 current 字段时抛出错误（由调用方转成用户可见信息）。
 */
export function resolveLaunchPlan(
  installRoot: string,
  record: { current?: unknown },
  platform: NodeJS.Platform,
  args: string[],
): LaunchPlan {
  if (typeof record.current !== "string" || record.current.length === 0) {
    throw new Error("安装记录缺少 current 字段，请重新安装")
  }
  const executableName = platform === "win32" ? "aizen-assistant.exe" : "aizen-assistant"
  return {
    executable: join(installRoot, "versions", record.current, executableName),
    dataDirectory: join(installRoot, "data"),
    args,
  }
}

/** 安装根目录：launcher 位于 <安装根>/bin/ 下，向上两层即为安装根。 */
function installRootFromLauncher(): string {
  return dirname(dirname(process.execPath))
}

/** 启动真实可执行文件并透传 stdio；返回其退出码。 */
async function launch(
  executable: string,
  dataDirectory: string,
  args: string[],
  injectDataDir: boolean,
): Promise<number> {
  const cmd = injectDataDir ? [executable, "--data-dir", dataDirectory, ...args] : [executable, ...args]
  const proc = Bun.spawn({
    cmd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return await proc.exited
}

async function main(): Promise<number> {
  const installRoot = installRootFromLauncher()
  const recordPath = join(installRoot, "install.json")
  let record: { current?: unknown }
  try {
    record = JSON.parse(await readFile(recordPath, "utf8")) as { current?: unknown }
  } catch (error) {
    console.error(`无法读取安装记录 ${recordPath}：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  let plan: LaunchPlan
  try {
    plan = resolveLaunchPlan(installRoot, record, process.platform, process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  if (!(await Bun.file(plan.executable).exists())) {
    console.error(`找不到可执行文件：${plan.executable}，请重新安装或运行 aizen-assistant update`)
    return 1
  }
  // 交互模式下 Ctrl+C 由子进程（TUI）处理，launcher 忽略信号、只透传退出码。
  process.on("SIGINT", () => {})
  const args = process.argv.slice(2)
  return await launch(plan.executable, plan.dataDirectory, args, shouldInjectDataDir(args))
}

if (import.meta.main) process.exitCode = await main()
