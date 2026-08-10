import { createTextAttributes, parseColor, StyledText, type TextChunk } from "@opentui/core"
import type { CoreSnapshot, CoreStatus, ResponseMetrics } from "../core/types.ts"
import type { PermissionPresetId, PermissionReviewMode } from "../core/tool-permissions/policy-types.ts"
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

const presetLabels: Record<PermissionPresetId, string> = {
  plan: "只读",
  edit: "编辑",
  "all-right": "全放开",
  custom: "自定义",
}

const reviewModeLabels: Record<PermissionReviewMode, string> = {
  manual: "完全人工",
  aiReview: "AI代审",
  aiReviewWithAbstain: "AI代审(可弃权)",
  autoApprove: "自动放过",
  autoDeny: "自动拒绝",
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
  const permission = `${presetLabels[snapshot.currentPermissionPreset ?? "edit"]}·${reviewModeLabels[snapshot.currentPermissionReviewMode ?? "manual"]}`
  const chunks: TextChunk[] = [
    { __isChunk: true, text: `模型：${model} | 视图：${view} | 权限：`, fg: parseColor(systemColors.secondary) },
    {
      __isChunk: true,
      text: permission,
      fg: parseColor(systemColors.sessionStatus),
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
  /** 本轮回复指标（耗时与生成 token 数），供第二条分割线内嵌显示；空闲时不存在。 */
  metrics?: ResponseMetrics
}

/** 各会话状态对应的展示文本（模块级常量，避免每次调用重建对象）。 */
const sessionStateText: Record<CoreStatus, string> = {
  idle: "空闲",
  running: "处理中",
  compacting: "正在压缩上下文",
  aborting: "正在中止",
  authenticating: "等待输入认证信息",
  refreshing: "正在刷新供应商模型",
  error: "发生错误",
}

/** 会话运行状态文本与回复指标（供第二条分割线内嵌显示）；错误消息由独立错误提示行承担。 */
export function sessionStateView(snapshot: CoreSnapshot): SessionState {
  return {
    text: sessionStateText[snapshot.status],
    tone: snapshot.status === "error" ? "error" : snapshot.status === "idle" ? "idle" : "running",
    ...(snapshot.responseMetrics ? { metrics: snapshot.responseMetrics } : {}),
  }
}

export function statusBarView(snapshot: CoreSnapshot, modelLabel?: string): StatusBarViewModel {
  return {
    session: sessionStatusText(snapshot, modelLabel),
    shortcuts: shortcutText({ status: snapshot.status, hasSession: !!snapshot.currentSessionId }),
  }
}
