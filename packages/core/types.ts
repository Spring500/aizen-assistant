import type { AuthPromptOption, AuthProviderOption, ModelOption } from "./pi-port.ts"
import type { MessageRecord, ModelReference, SessionRecord, TurnInputItem, ViewReference } from "./session-format.ts"
import type { SessionSummary } from "./session-store.ts"

export type CoreStatus = "idle" | "running" | "aborting" | "authenticating" | "error"

export type TranscriptEntry =
  | { type: "input"; turnId: string; items: TurnInputItem[] }
  | { type: "message"; turnId: string; message: MessageRecord["message"] }
  | { type: "turn_end"; turnId: string; outcome: "completed" | "aborted" | "failed" }

export type ActiveTool = { callId: string; name: string; isError?: boolean }

export type CoreSnapshot = {
  cwd: string
  status: CoreStatus
  sessions: SessionSummary[]
  currentSessionId?: string
  currentModel?: ModelReference
  currentView?: ViewReference
  models: ModelOption[]
  authProviders: AuthProviderOption[]
  transcript: TranscriptEntry[]
  activeTools: ActiveTool[]
  streamingText: string
  streamingThinking: string
  lastError?: string
}

export type CoreCommand =
  | { type: "list_sessions" }
  | { type: "create_session"; model: ModelReference }
  | { type: "open_session"; sessionId: string }
  | { type: "send_prompt"; text: string }
  | { type: "abort" }
  | { type: "list_models" }
  | { type: "set_model"; model: ModelReference }
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

export type CoreCommandResult = { ok: true } | { ok: false; error: string }

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
