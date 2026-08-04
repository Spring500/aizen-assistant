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
    await super.append(sessionId, record)
    if (matchesCheckpoint(record, this.checkpoint)) {
      await writeFile(this.readyPath, "ready")
      await new Promise<void>(() => {})
    }
  }
}

async function main(): Promise<void> {
  const input = JSON.parse(process.argv[2] ?? "{}") as Scenario
  const pi = await PiSessionRuntime.create({ authPath: join(input.root, "auth.json"), modelsPath: null })
  await pi.setRuntimeApiKey("anthropic", "test-key")
  const model = (await pi.listModels()).find(
    (item) => item.providerId === "anthropic" && item.modelId === "claude-sonnet-4-6",
  )
  if (!model) throw new Error("缺少测试模型")
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
        validator: {
          toolName: "checkpoint_tool",
          validate: async () => {
            const assessment = {
              summary: "写入检查点副作用",
              targets: [join(input.root, "effect.txt")],
              risk: "medium" as const,
              reason:
                input.checkpoint === "permissionRequested"
                  ? "需要人工确认"
                  : input.checkpoint === "authorizedDenied"
                    ? "测试拒绝执行"
                    : "测试允许执行",
              findings: [],
            }
            if (input.checkpoint === "permissionRequested") return { type: "needHumanReview" as const, assessment }
            if (input.checkpoint === "authorizedDenied")
              return {
                type: "deny" as const,
                reason: "Operation denied: Test policy rejected the tool call.",
                assessment,
              }
            return { type: "allow" as const, assessment }
          },
        },
        execute: async () => {
          await writeFile(join(input.root, "effect.txt"), "executed")
          if (input.checkpoint === "toolSideEffect") {
            await writeFile(input.readyPath, "ready")
            await new Promise<void>(() => {})
          }
          if (input.checkpoint === "executionFailed") throw new Error("测试工具产生部分影响后失败")
          return { content: [{ type: "text", text: "checkpoint completed" }] }
        },
      },
    ],
  })
  const reference: ModelReference = model
  await core.dispatch({ type: "create_session", model: reference, viewId: null, permissionMode: "hybrid" })
  const sessionId = core.getSnapshot().currentSessionId
  if (!sessionId) throw new Error("会话创建失败")
  await writeFile(input.sessionIdPath, sessionId)
  await core.dispatch({ type: "send_prompt", text: "运行检查点工具" })
  throw new Error("目标检查点没有阻塞")
}

await main()
