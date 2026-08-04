import type { AizenToolRegistration } from "./tool-registry.ts"
import type { MessageRecord, ModelReference, SessionRecord, TurnInputItem, ViewId } from "./session-format.ts"
import type {
  AiPermissionReviewer,
  PermissionMode,
  ToolPermissionBatchAuthorization,
  ToolPermissionBatchRequest,
  ToolAuthorization,
  ToolPermissionRequest,
} from "./tool-permissions/types.ts"

/** 表示当前模型或思考档位不能用于创建 pi 内存会话，交互层可引导用户重新选择。 */
export class PiModelRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PiModelRuntimeError"
  }
}

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
  thinkingLevels?: string[]
  offThinkingLevel?: string
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
  sessionId?: string
  turnId: string
  viewId: ViewId
  permissionMode?: PermissionMode
  items: TurnInputItem[]
}

export type PiSessionTitleInput = {
  model: Pick<ModelReference, "providerId" | "modelId">
  firstUserMessage: string
  signal?: AbortSignal
}

export type PiPermissionHandler = (request: ToolPermissionRequest, signal?: AbortSignal) => Promise<ToolAuthorization>

export type PiPermissionBatchHandler = (
  batch: ToolPermissionBatchRequest,
  signal?: AbortSignal,
) => Promise<ToolPermissionBatchAuthorization>

export type PiPermissionExecutionEvent = {
  phase: "executionStarted" | "executionFinished"
  request: ToolPermissionRequest
  authorization: ToolAuthorization
  isError?: boolean
  error?: string
  at: string
}

export type PiPermissionExecutionHandler = (event: PiPermissionExecutionEvent) => Promise<void>

export interface PiPort {
  create(input: PiCreateInput): Promise<ModelRuntimeInfo>
  restore(input: PiRestoreInput): Promise<ModelRuntimeInfo>
  refreshView(view: ViewRuntimeInput): Promise<void>
  switchView(view: ViewRuntimeInput, records: SessionRecord[]): Promise<ModelRuntimeInfo>
  prompt(input: PiPromptInput): Promise<void>
  /** 使用独立模型请求为首条用户消息生成经过校验的会话标题。 */
  generateSessionTitle(input: PiSessionTitleInput): Promise<string>
  /** 设置经过联合注册的项目自有工具；adapter 负责转换到当前 Agent Loop。 */
  setToolRegistrations?(registrations: AizenToolRegistration[]): void
  /** 设置核心提供的工具批次权限处理器。 */
  setPermissionBatchHandler?(handler: PiPermissionBatchHandler | undefined): void
  /** 设置核心提供的单工具权限处理器，仅供旧适配器兼容。 */
  setPermissionHandler?(handler: PiPermissionHandler | undefined): void
  /** 设置工具执行阶段记录处理器。 */
  setPermissionExecutionHandler?(handler: PiPermissionExecutionHandler | undefined): void
  /** 返回使用当前模型运行时的独立 AI 权限审核器。 */
  permissionReviewer?(model: Pick<ModelReference, "providerId" | "modelId">): AiPermissionReviewer
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
