import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import lockfile from "proper-lockfile"
import writeFileAtomic from "write-file-atomic"

const lockOptions = {
  realpath: false,
  stale: 10_000,
  update: 2_000,
  retries: { retries: 20, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
} as const

/** 以临时文件、刷盘和原子替换的方式完整写入文件。 */
export async function atomicWriteFile(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFileAtomic(path, content, { encoding: "utf8", fsync: true })
}

/** 在同进程及跨进程互斥锁内执行一次文件事务。 */
export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  lockPath = `${path}.lock`,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true })
  const release = await lockfile.lock(path, { ...lockOptions, lockfilePath: lockPath })
  try {
    return await operation()
  } finally {
    await release()
  }
}
