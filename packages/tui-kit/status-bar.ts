import type { CoreSnapshot, CoreStatus } from "../core/types.ts"

export type ShortcutContext = {
  status: CoreStatus
  hasSession: boolean
}

export type StatusBarViewModel = {
  session: string
  shortcuts: string
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US")
}

function contextText(snapshot: CoreSnapshot): string {
  const used = snapshot.contextUsage?.used ?? 0
  const total = snapshot.contextUsage?.total
  return total ? `${formatNumber(used)}/${formatNumber(total)}` : `${formatNumber(used)}/未知`
}

export function sessionStatusText(snapshot: CoreSnapshot): string {
  const model = snapshot.currentModel
    ? `${snapshot.currentModel.providerId}/${snapshot.currentModel.modelId}`
    : "未选择模型"
  return `模型：${model} | 上下文：${contextText(snapshot)}`
}

export function shortcutText(context: ShortcutContext): string {
  const global = "Ctrl+C 退出"
  if (context.status === "running" || context.status === "aborting") return `Esc 中止 | ${global}`
  if (context.status === "authenticating") return `Esc 取消认证 | ${global}`
  if (!context.hasSession) return `↑/↓ 选择 | Enter 确认 | Esc 返回 | ${global}`
  return `Enter 发送 | Shift+Enter 或 \\+Enter 换行 | Esc 中止 | /model 切换模型 | /sessions 会话 | /new 新会话 | /fold 折叠 | /quit 退出 | ${global}`
}

export function statusBarView(snapshot: CoreSnapshot): StatusBarViewModel {
  return {
    session: sessionStatusText(snapshot),
    shortcuts: shortcutText({ status: snapshot.status, hasSession: !!snapshot.currentSessionId }),
  }
}
