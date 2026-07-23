import { basename, dirname, join, win32 } from "node:path"

export function dataDirectoryFromExecutable(executablePath: string): string {
  const path = /^[A-Za-z]:[\\/]/.test(executablePath) ? win32 : { dirname, join }
  return path.join(path.dirname(executablePath), "data")
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
