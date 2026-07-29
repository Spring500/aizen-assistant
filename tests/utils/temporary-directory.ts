import { rm } from "node:fs/promises"

export type RemoveTemporaryDirectoryOptions = {
  timeoutMs?: number
  intervalMs?: number
}

const retryableCodes = new Set(["EBUSY", "EPERM", "ENOTEMPTY"])

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

/**
 * 删除测试临时目录；遇到 Windows 短暂文件锁时等待重试，超时后保留原始错误。
 */
export async function removeTemporaryDirectory(
  path: string,
  options: RemoveTemporaryDirectoryOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs
  let attempts = 0

  while (true) {
    attempts += 1
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      const code = errorCode(error)
      if (!code || !retryableCodes.has(code) || Date.now() >= deadline) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`删除临时目录失败：${path}；尝试 ${attempts} 次；错误 ${code ?? "UNKNOWN"}：${detail}`, {
          cause: error,
        })
      }
      await Bun.sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())))
    }
  }
}
