import { basename, dirname, join, resolve, win32 } from "node:path"

export function dataDirectoryFromExecutable(executablePath: string): string {
  const path = /^[A-Za-z]:[\\/]/.test(executablePath) ? win32 : { dirname, join }
  return path.join(path.dirname(executablePath), ".aizen")
}

export function resolveDataDirectory(
  specifiedDirectory: string | undefined,
  executablePath: string,
  cwd: string,
  sourceMode: boolean,
): string {
  if (!specifiedDirectory) {
    if (sourceMode) throw new Error("源码运行交互模式时必须传入 --data-dir <目录>")
    return dataDirectoryFromExecutable(executablePath)
  }
  const path = /^[A-Za-z]:[\\/]/.test(cwd) ? win32 : { resolve }
  const directory = path.resolve(cwd, specifiedDirectory)
  if (directory === path.resolve(cwd)) throw new Error("数据目录不能是当前工作目录")
  return directory
}

export function normalizeProjectPath(cwd: string): string {
  if (/^[A-Za-z]:[\\/]/.test(cwd))
    return win32
      .normalize(cwd)
      .replace(/[\\/]+$/, "")
      .toLowerCase()
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

export function projectDirectoryName(cwd: string): string {
  const normalized = normalizeProjectPath(cwd)
  const name = (/^[A-Za-z]:\\/.test(normalized) ? win32.basename(normalized) : basename(normalized)) || "root"
  const hash = new Bun.CryptoHasher("sha256").update(normalized).digest("hex").slice(0, 12)
  return `${name}-${hash}`
}
