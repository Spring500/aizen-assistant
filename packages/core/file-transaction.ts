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

/** 获取并长期持有一次文件锁；调用方负责在生命周期结束时释放。 */
export async function acquireFileLock(
  path: string,
  options: Parameters<typeof lockfile.lock>[1] = {},
): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true })
  return lockfile.lock(path, { ...lockOptions, ...options })
}

/** 检查文件对应的锁是否存在且尚未过期。 */
export async function isFileLocked(path: string, options: Parameters<typeof lockfile.check>[1] = {}): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  return lockfile.check(path, { ...lockOptions, ...options })
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
