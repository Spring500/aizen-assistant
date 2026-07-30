import type { AppPreferences, FoldPreferences } from "./app-preferences-store.ts"
import type { EditableModelConfig, EditableProviderConfig, ModelConfigSnapshot } from "./model-config-store.ts"
import type { ViewOption } from "./view-store.ts"
import type { AuthPromptOption, AuthProviderOption, ModelOption, ModelRuntimeInfo } from "./pi-port.ts"
import type { MessageRecord, ModelReference, SessionRecord, TurnInputItem, ViewId } from "./session-format.ts"
import type { SessionSummary } from "./session-store.ts"

export type CoreStatus = "idle" | "running" | "aborting" | "authenticating" | "error"

export type TranscriptEntry =
  | { type: "input"; turnId: string; items: TurnInputItem[] }
  | { type: "message"; turnId: string; message: MessageRecord["message"] }
  | { type: "turn_end"; turnId: string; outcome: "completed" | "aborted" | "failed" }

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

export type CoreSnapshot = {
  cwd: string
  status: CoreStatus
  sessions: SessionSummary[]
  currentSessionId?: string
  currentSessionName?: string
  currentModel?: ModelRuntimeInfo
  currentViewId?: ViewId
  models: ModelOption[]
  modelConfig?: ModelConfigSnapshot
  preferences: AppPreferences
  views: ViewOption[]
  authProviders: AuthProviderOption[]
  transcript: TranscriptEntry[]
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
  | { type: "list_sessions" }
  | { type: "list_views" }
  | { type: "create_session"; model: ModelReference; viewId: ViewId }
  | { type: "open_session"; sessionId: string }
  | { type: "rename_session"; sessionId: string; name: string }
  | { type: "rewind"; turnId: string }
  | { type: "fork_session"; turnId: string }
  | { type: "send_prompt"; text: string }
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
  | { type: "create_view"; name: string; id?: string }
  | { type: "update_view"; viewId: string; name?: string; path?: string }
  | { type: "ensure_view_file"; viewId: string; name: "SYSTEM.md" | "AGENTS.md" }
  | { type: "remove_view"; viewId: string; deleteDirectory?: boolean }
  | { type: "list_auth_providers" }
  | { type: "login_api_key"; providerId: string }
  | { type: "answer_auth_prompt"; promptId: string; value: string }
  | { type: "cancel_auth" }

export type CoreEvent =
  | { type: "snapshot"; snapshot: CoreSnapshot }
  | {
      type: "auth_prompt"
      promptId: string
      promptType: "text" | "secret" | "select"
      message: string
      placeholder?: string
      options?: AuthPromptOption[]
    }

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
    if (record.kind === "turn_started") entries.push({ type: "input", turnId: record.turnId, items: record.items })
    if (record.kind === "message") entries.push({ type: "message", turnId: record.turnId, message: record.message })
    if (record.kind === "turn_finished")
      entries.push({ type: "turn_end", turnId: record.turnId, outcome: record.outcome })
  }
  return entries
}
