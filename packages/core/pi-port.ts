import type { MessageRecord, ModelReference, SessionRecord, TurnInputItem, ViewId } from "./session-format.ts"

export type ViewRuntimeInput =
  | { viewId: null }
  | {
      viewId: string
      directory: string
    }

export type ModelRuntimeInfo = ModelReference & {
  contextWindow?: number
}

export type ModelOption = ModelRuntimeInfo & {
  name: string
  available: boolean
}

export type AuthProviderOption = {
  id: string
  name: string
  configured: boolean
  supportsApiKey: boolean
}

export type AuthPromptOption = { id: string; label: string; description?: string }

export type PiPortEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "usage_updated"; outputTokens: number; contextTokens?: number }
  | {
      type: "message"
      recordId: string
      record: Omit<MessageRecord, "recordId" | "turnId" | "at">["message"]
    }
  | { type: "tool_started"; callId: string; name: string; arguments: unknown }
  | { type: "tool_updated"; callId: string; name: string; output: string }
  | { type: "tool_finished"; callId: string; name: string; isError: boolean }
  | {
      type: "compaction"
      summary: string
      firstKeptRecordId: string
      tokensBefore: number
    }
  | { type: "settled" }
  | {
      type: "auth_prompt"
      promptId: string
      promptType: "text" | "secret" | "select"
      message: string
      placeholder?: string
      options?: AuthPromptOption[]
    }
  | { type: "auth_notice"; message: string }

export type PiCreateInput = {
  cwd: string
  model: ModelReference
  view: ViewRuntimeInput
}

export type PiRestoreInput = PiCreateInput & {
  records: SessionRecord[]
}

export type PiPromptInput = {
  recordId: string
  turnId: string
  viewId: ViewId
  items: TurnInputItem[]
}

export interface PiPort {
  create(input: PiCreateInput): Promise<ModelRuntimeInfo>
  restore(input: PiRestoreInput): Promise<ModelRuntimeInfo>
  refreshView(view: ViewRuntimeInput): Promise<void>
  switchView(view: ViewRuntimeInput, records: SessionRecord[]): Promise<ModelRuntimeInfo>
  prompt(input: PiPromptInput): Promise<void>
  abort(): Promise<void>
  listModels(): Promise<ModelOption[]>
  reloadModelConfig(): Promise<void>
  setModel(model: ModelReference): Promise<ModelRuntimeInfo>

  listAuthProviders(): Promise<AuthProviderOption[]>
  loginApiKey(providerId: string): Promise<void>
  answerAuthPrompt(promptId: string, value: string): void
  cancelAuth(): void
  subscribe(listener: (event: PiPortEvent) => void): () => void
  dispose(): Promise<void>
}
