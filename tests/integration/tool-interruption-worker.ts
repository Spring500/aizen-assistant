import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import type { ModelReference, SessionRecord } from "../../packages/core/session-format.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"

type Checkpoint =
  | "assistantMessage"
  | "permissionRequested"
  | "validated"
  | "authorized"
  | "authorizedDenied"
  | "executionStarted"
  | "toolSideEffect"
  | "executionFinished"
  | "executionFailed"
  | "toolMessage"

type Scenario = {
  root: string
  mockUrl: string
  checkpoint: Checkpoint
  readyPath: string
  sessionIdPath: string
}

function trace(checkpoint: Checkpoint, stage: string): void {
  console.log(`${new Date().toISOString()} [工具中断/${checkpoint}/worker] ${stage}`)
}

function recordStage(record: SessionRecord): string {
  if (record.kind === "message") return `message:${record.message.role}`
  if (record.kind === "tool_permission") {
    const event = eventObject(record)
    return `tool_permission:${String(event?.type ?? event?.phase ?? "unknown")}`
  }
  return record.kind
}

function eventObject(record: SessionRecord): Record<string, unknown> | undefined {
  return record.kind === "tool_permission" &&
    record.event &&
    typeof record.event === "object" &&
    !Array.isArray(record.event)
    ? record.event
    : undefined
}

function matchesCheckpoint(record: SessionRecord, checkpoint: Checkpoint): boolean {
  const event = eventObject(record)
  if (checkpoint === "assistantMessage")
    return (
      record.kind === "message" &&
      record.message.role === "assistant" &&
      record.message.parts.some((part) => part.kind === "tool_call")
    )
  if (checkpoint === "toolMessage") return record.kind === "message" && record.message.role === "tool"
  if (
    checkpoint === "permissionRequested" ||
    checkpoint === "validated" ||
    checkpoint === "authorized" ||
    checkpoint === "authorizedDenied"
  )
    return event?.type === (checkpoint === "authorizedDenied" ? "authorized" : checkpoint)
  if (checkpoint === "executionStarted" || checkpoint === "executionFinished" || checkpoint === "executionFailed")
    return event?.phase === (checkpoint === "executionFailed" ? "executionFinished" : checkpoint)
  return false
}

class CheckpointSessionStore extends SessionStore {
  constructor(
    root: string,
    private readonly checkpoint: Checkpoint,
    private readonly readyPath: string,
  ) {
    super(root)
  }

  /** 在目标记录已完成真实 append/fsync 后阻止业务进入下一阶段。 */
  override async append(sessionId: string, record: SessionRecord): Promise<void> {
    const stage = recordStage(record)
    trace(this.checkpoint, `开始落盘 ${stage}`)
    await super.append(sessionId, record)
    trace(this.checkpoint, `完成落盘 ${stage}`)
    if (matchesCheckpoint(record, this.checkpoint)) {
      trace(this.checkpoint, `命中检查点 ${stage}`)
      await writeFile(this.readyPath, "ready")
      trace(this.checkpoint, "检查点文件已写入，等待父进程终止")
      await new Promise<void>(() => {})
    }
  }
}

async function main(): Promise<void> {
  const input = JSON.parse(process.argv[2] ?? "{}") as Scenario
  trace(input.checkpoint, "启动")
  const pi = await PiSessionRuntime.create({ authPath: join(input.root, "auth.json"), customProvidersPath: null })
  trace(input.checkpoint, "pi runtime 已创建")
  await pi.setRuntimeApiKey("anthropic", "test-key")
  trace(input.checkpoint, "运行时认证已配置")
  const model = (await pi.listModels()).find(
    (item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6",
  )
  if (!model) throw new Error("缺少测试模型")
  trace(input.checkpoint, "测试模型已加载")
  pi.setModelBaseUrl(model.providerId, model.modelId, input.mockUrl)
  const store = new CheckpointSessionStore(join(input.root, "sessions"), input.checkpoint, input.readyPath)
  const core = new AizenCore({
    cwd: input.root,
    store,
    pi,
    toolRegistrations: [
      {
        kind: "inProcess",
        descriptor: {
          name: "checkpoint_tool",
          label: "checkpoint_tool",
          description: "写入检查点副作用",
          parameters: { type: "object", properties: {}, required: [] },
        },
        classifier: {
          id: "user/checkpoint-tool@1",
          toolNames: ["checkpoint_tool"],
          classify: async () => {
            trace(input.checkpoint, "开始验证工具权限")
            if (input.checkpoint === "permissionRequested")
              return { kind: "claims" as const, claims: [{ tag: "system-change" as const, reason: "需要人工确认" }] }
            if (input.checkpoint === "authorizedDenied")
              return {
                kind: "claims" as const,
                claims: [{ tag: "violation" as const, reason: "测试拒绝执行" }],
              }
            return { kind: "claims" as const, claims: [] }
          },
        },
        execute: async () => {
          trace(input.checkpoint, "开始执行工具")
          await writeFile(join(input.root, "effect.txt"), "executed")
          trace(input.checkpoint, "工具副作用已写入")
          if (input.checkpoint === "toolSideEffect") {
            await writeFile(input.readyPath, "ready")
            trace(input.checkpoint, "检查点文件已写入，等待父进程终止")
            await new Promise<void>(() => {})
          }
          if (input.checkpoint === "executionFailed") throw new Error("测试工具产生部分影响后失败")
          trace(input.checkpoint, "工具执行完成")
          return { content: [{ type: "text", text: "checkpoint completed" }] }
        },
      },
    ],
  })
  trace(input.checkpoint, "Core 已创建")
  const reference: ModelReference = model
  await core.dispatch({ type: "create_session", model: reference, viewId: null, permissionMode: "hybrid" })
  trace(input.checkpoint, "会话已创建")
  const sessionId = core.getSnapshot().currentSessionId
  if (!sessionId) throw new Error("会话创建失败")
  await writeFile(input.sessionIdPath, sessionId)
  trace(input.checkpoint, "会话 ID 已写入，开始发送工具请求")
  await core.dispatch({ type: "send_prompt", text: "运行检查点工具" })
  throw new Error("目标检查点没有阻塞")
}

await main()
