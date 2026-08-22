import type { AgentPreferences, AppPreferences, FoldPreferences } from "./app-preferences-store.ts"
import type { EditableModelConfig, EditableProviderConfig, ModelConfigSnapshot } from "./model-config-store.ts"
import type {
  AuthPromptOption,
  AuthProviderOption,
  ModelOption,
  ModelRuntimeInfo,
  PiProviderOption,
  RuntimeContextReport,
} from "./pi-port.ts"
import type { MessageRecord, ModelReference, SessionRecord, TurnInputItem, ViewId } from "./session-format.ts"
import { workingDirectoryChangeText } from "./session-projection.ts"
import type { SessionSummary } from "./session-store.ts"
import type { PermissionPresetId, PermissionReviewMode } from "./tool-permissions/policy-types.ts"
import type { HumanReviewRequest } from "./tool-permissions/types.ts"
import type { ViewOption } from "./view-store.ts"

export type CoreStatus = "idle" | "running" | "compacting" | "aborting" | "authenticating" | "refreshing" | "error"

export type TranscriptEntry =
  | { type: "environment"; recordId: string; text: string }
  | { type: "compaction_summary"; recordId: string; summary: string; tokensBefore: number }
  | { type: "input"; turnId: string; items: TurnInputItem[] }
  | { type: "message"; turnId: string; message: MessageRecord["message"] }
  | { type: "turn_end"; turnId: string; outcome: "completed" | "aborted" | "failed" }

/** 完整会话中的已完成用户轮次，供 rewind/fork 使用，不受主对话压缩投影影响。 */
export type ConversationHistoryTurn = {
  turnId: string
  text: string
  compacted: boolean
}

export type ActiveTool = {
  callId: string
  name: string
  arguments: unknown
  outputPreview?: string
  isFinished?: boolean
  isError?: boolean
}

export type ResponseMetrics = {
  startedAt: number
  elapsedSeconds: number
  outputTokens: number
}

export type ContextUsage = {
  used: number
  total?: number
}

/** 会话已经可以查看和编辑，但当前 pi runtime 尚不能安全发送下一轮请求。 */
export type RuntimeIssue = {
  kind: "model" | "view" | "runtime"
  message: string
}

/**
 * 运行时上下文查看的完整报告：adapter 现场读取的系统提示词与工具清单，
 * 加上 core 现场预览的“下一条消息将被注入的临时上下文”。仅供展示，不落盘。
 */
export type ContextReport = RuntimeContextReport & {
  injectedItems: TurnInputItem[]
}

export type CoreSnapshot = {
  cwd: string
  status: CoreStatus
  sessions: SessionSummary[]
  currentSessionId?: string
  currentSessionName?: string
  currentModel?: ModelRuntimeInfo
  currentViewId?: ViewId
  currentPermissionPreset?: PermissionPresetId
  currentPermissionReviewMode?: PermissionReviewMode
  pendingPermissionRequests?: HumanReviewRequest[]
  permissionReviewError?: string
  runtimeIssue?: RuntimeIssue
  models: ModelOption[]
  modelConfig?: ModelConfigSnapshot
  preferences: AppPreferences
  views: ViewOption[]
  authProviders: AuthProviderOption[]
  piProviders?: PiProviderOption[]
  transcript: TranscriptEntry[]
  /** transcript 的语义版本；内容被压缩重投影但长度不变时也会递增。 */
  transcriptRevision: number
  /** 完整会话中的已完成轮次，专供 rewind/fork 等历史操作。 */
  historyTurns: ConversationHistoryTurn[]
  activeTools: ActiveTool[]
  responseMetrics?: ResponseMetrics
  contextUsage?: ContextUsage
  streamingText: string
  streamingThinking: string
  lastError?: string
}

export type CoreCommand =
  | { type: "load_preferences" }
  | { type: "save_fold_preferences"; fold: FoldPreferences }
  | { type: "save_agent_preferences"; agents: AgentPreferences }
  | { type: "list_sessions" }
  | { type: "list_views" }
  | {
      type: "create_session"
      model: ModelReference
      viewId: ViewId
      permissionPreset?: PermissionPresetId
      permissionReviewMode?: PermissionReviewMode
    }
  | { type: "open_session"; sessionId: string }
  | { type: "rename_session"; sessionId: string; name: string }
  | { type: "rewind"; turnId: string }
  | { type: "fork_session"; turnId: string }
  | { type: "send_prompt"; text: string }
  | { type: "compact"; customInstructions?: string }
  | { type: "abort" }
  | { type: "list_models" }
  | { type: "load_model_config" }
  | { type: "save_provider"; revision: string; provider: EditableProviderConfig; create?: boolean }
  | { type: "delete_provider"; revision: string; providerId: string }
  | {
      type: "save_model"
      revision: string
      providerId: string
      model: EditableModelConfig
      create?: boolean
    }
  | { type: "delete_model"; revision: string; providerId: string; modelId: string }
  | { type: "set_model"; model: ModelReference }
  | { type: "set_view"; viewId: ViewId }
  | { type: "set_permission_settings"; preset: PermissionPresetId; reviewMode: PermissionReviewMode }
  | {
      type: "answer_permission_batch"
      batchId: string
      answers: Array<{ requestId: string; type: "approve" | "deny"; reason?: string }>
    }
  | {
      type: "answer_permission_request"
      requestId: string
      decision: "approve" | "deny"
      reason?: string
    }
  | { type: "create_view"; name: string; id?: string }
  | { type: "update_view"; viewId: string; name?: string; path?: string }
  | { type: "ensure_view_file"; viewId: string; name: "SYSTEM.md" | "AGENTS.md" }
  | { type: "remove_view"; viewId: string; deleteDirectory?: boolean }
  | { type: "list_auth_providers" }
  | { type: "list_pi_providers" }
  | { type: "set_pi_provider_enabled"; providerId: string; enabled: boolean }
  | { type: "refresh_pi_provider"; providerId: string }
  | { type: "login_pi_provider"; providerId: string; authType: "api_key" | "oauth" }
  | { type: "login_api_key"; providerId: string }
  | { type: "answer_auth_prompt"; promptId: string; value: string }
  | { type: "cancel_auth" }
  | { type: "describe_context" }

export type CoreEvent =
  | { type: "snapshot"; snapshot: CoreSnapshot }
  | { type: "permission_request"; request: HumanReviewRequest }
  | {
      type: "auth_prompt"
      promptId: string
      promptType: "text" | "secret" | "select"
      message: string
      placeholder?: string
      options?: AuthPromptOption[]
    }
  | {
      type: "auth_notice"
      message: string
      links?: Array<{ url: string; label?: string }>
      deviceCode?: { userCode: string; verificationUri: string; expiresInSeconds?: number }
    }
  | { type: "context_report"; report: ContextReport }

export type CoreError = {
  code: string
  message: string
  severity: "error" | "fatal"
}

export type CoreCommandResult = { ok: true } | { ok: false; error: CoreError }

export interface CorePort {
  dispatch(command: CoreCommand): Promise<CoreCommandResult>
  subscribe(listener: (event: CoreEvent) => void): () => void
  getSnapshot(): CoreSnapshot
  dispose(): Promise<void>
}

export function recordsToTranscript(records: SessionRecord[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const record of records) {
    if (record.kind === "working_directory_changed")
      entries.push({
        type: "environment",
        recordId: record.recordId,
        text: workingDirectoryChangeText(record.previousCwd, record.currentCwd),
      })
    if (record.kind === "compaction")
      entries.push({
        type: "compaction_summary",
        recordId: record.recordId,
        summary: record.summary,
        tokensBefore: record.tokensBefore,
      })
    if (record.kind === "turn_started") entries.push({ type: "input", turnId: record.turnId, items: record.items })
    if (record.kind === "message") entries.push({ type: "message", turnId: record.turnId, message: record.message })
    if (record.kind === "turn_finished")
      entries.push({ type: "turn_end", turnId: record.turnId, outcome: record.outcome })
  }
  return entries
}
