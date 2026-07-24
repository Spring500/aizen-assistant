import type { MessageRecord, ModelReference, SessionRecord, TurnInputItem, ViewId } from "./session-format.ts"

export type ModelOption = ModelReference & {
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
  | {
      type: "message"
      runtimeRef: string
      record: Omit<MessageRecord, "recordId" | "turnId" | "at">["message"]
    }
  | { type: "tool_started"; callId: string; name: string; arguments: unknown }
  | { type: "tool_updated"; callId: string; name: string; output: string }
  | { type: "tool_finished"; callId: string; name: string; isError: boolean }
  | {
      type: "compaction"
      summary: string
      firstKeptRuntimeRef: string
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
  viewId: ViewId
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
  create(input: PiCreateInput): Promise<ModelReference>
  restore(input: PiRestoreInput): Promise<ModelReference>
  prompt(input: PiPromptInput): Promise<void>
  abort(): Promise<void>
  listModels(): Promise<ModelOption[]>
  setModel(model: ModelReference): Promise<ModelReference>
  listAuthProviders(): Promise<AuthProviderOption[]>
  loginApiKey(providerId: string): Promise<void>
  answerAuthPrompt(promptId: string, value: string): void
  cancelAuth(): void
  subscribe(listener: (event: PiPortEvent) => void): () => void
  dispose(): Promise<void>
}
