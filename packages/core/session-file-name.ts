/** 将会话创建时间格式化为便于用户排序的本地文件名前缀。 */
export function sessionFileName(createdAt: string, sessionId: string): string {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) throw new Error("会话创建时间无效")
  const pad = (value: number) => String(value).padStart(2, "0")
  const offsetMinutes = -date.getTimezoneOffset()
  const offsetSign = offsetMinutes >= 0 ? "+" : "-"
  const offset = Math.abs(offsetMinutes)
  const timestamp = [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}-${pad(date.getMinutes())}`,
    `${offsetSign}${pad(Math.floor(offset / 60))}-${pad(offset % 60)}`,
  ].join("")
  return `${timestamp}_${sessionId}.jsonl`
}
