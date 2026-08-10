import { createTextAttributes, parseColor, StyledText, type TextChunk } from "@opentui/core"
import type { CoreSnapshot, CoreStatus } from "../core/types.ts"
import type { PermissionMode } from "../core/tool-permissions/types.ts"
import { systemColors } from "./theme.ts"

export type ShortcutContext = {
  status: CoreStatus
  hasSession: boolean
}

export type StatusBarViewModel = {
  session: string | StyledText
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

const permissionModeView: Record<PermissionMode, { label: string; color: string }> = {
  unrestricted: { label: "完全开放", color: systemColors.statusError },
  hybrid: { label: "自动+人工", color: systemColors.sessionStatus },
  hybridConfirmDenials: { label: "自动+人工确认拒绝", color: systemColors.statusIdle },
  aiOnly: { label: "仅自动审核", color: systemColors.statusRunning },
}

/**
 * 会话状态文本；modelLabel 为外部构建的模型显示文本（含思考等级名）时优先使用，
 * 否则回退 providerId/modelId 形式。
 */
export function sessionStatusText(snapshot: CoreSnapshot, modelLabel?: string): string | StyledText {
  const model =
    modelLabel ??
    (snapshot.currentModel ? `${snapshot.currentModel.providerId}/${snapshot.currentModel.modelId}` : "未选择模型")
  const view = snapshot.currentViewId ?? "未选择视图"
  const mode = permissionModeView[snapshot.currentPermissionMode ?? "hybrid"]
  const chunks: TextChunk[] = [
    { __isChunk: true, text: `模型：${model} | 视图：${view} | 权限：`, fg: parseColor(systemColors.secondary) },
    {
      __isChunk: true,
      text: mode.label,
      fg: parseColor(mode.color),
      attributes: createTextAttributes({ bold: true }),
    },
    { __isChunk: true, text: ` | 上下文：${contextText(snapshot)}`, fg: parseColor(systemColors.secondary) },
  ]
  if (snapshot.permissionReviewError)
    chunks.push({
      __isChunk: true,
      text: " | 工具审核模型：异常",
      fg: parseColor(systemColors.statusError),
      attributes: createTextAttributes({ bold: true }),
    })
  return new StyledText(chunks)
}

export function shortcutText(context: ShortcutContext): string {
  const global = "Ctrl+C 退出"
  if (context.status === "running" || context.status === "compacting" || context.status === "aborting")
    return `Esc 中止 | ${global}`
  if (context.status === "authenticating") return `Esc 取消认证 | ${global}`
  if (context.status === "refreshing") return `请等待刷新完成 | ${global}`
  if (!context.hasSession) return `↑/↓ 选择 | Enter 确认 | Esc 返回 | ${global}`
  return `Enter 发送 | Shift+Enter 换行 | 光标前 \\ 后 Enter 换行 | Esc 中止 | ${global}`
}

export type SessionState = {
  text: string
  tone: "idle" | "running" | "error"
}

/** 会话运行状态文本（供第二条分割线内嵌显示），错误优先展示错误消息。 */
export function sessionStateView(snapshot: CoreSnapshot): SessionState {
  if (snapshot.lastError) return { text: `错误：${snapshot.lastError}`, tone: "error" }
  const text = {
    idle: "空闲",
    running: "处理中",
    compacting: "正在压缩上下文",
    aborting: "正在中止",
    authenticating: "等待输入认证信息",
    refreshing: "正在刷新供应商模型",
    error: "发生错误",
  }[snapshot.status]
  return { text, tone: snapshot.status === "idle" ? "idle" : "running" }
}

export function statusBarView(snapshot: CoreSnapshot, modelLabel?: string): StatusBarViewModel {
  return {
    session: sessionStatusText(snapshot, modelLabel),
    shortcuts: shortcutText({ status: snapshot.status, hasSession: !!snapshot.currentSessionId }),
  }
}
