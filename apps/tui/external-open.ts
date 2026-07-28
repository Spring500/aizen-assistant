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
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" })
  const exitCode = await child.exited
  if (exitCode !== 0)
    throw new Error(`无法打开目录：${new TextDecoder().decode(await new Response(child.stderr).arrayBuffer())}`)
}
