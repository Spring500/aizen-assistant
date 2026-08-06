import { dirname } from "node:path"

export async function openExternalEditor(path: string): Promise<void> {
  const command = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "nano")
  const child = Bun.spawn([command, path], {
    cwd: dirname(path),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`编辑器退出码：${exitCode}`)
}

export async function openDirectory(path: string): Promise<void> {
  const command =
    process.platform === "win32"
      ? ["explorer", path]
      : process.platform === "darwin"
        ? ["open", path]
        : ["xdg-open", path]
  // 目录打开器是即发即忘的 GUI 程序：Windows 的 explorer 成功打开也返回退出码 1，
  // xdg-open / open 会立即返回，退出码都不能表示打开结果，因此只处理启动失败。
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
  void child.exited.catch(() => {})
}
