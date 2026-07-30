import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import type { ModelReference } from "../../packages/core/session-format.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import type {
  AiPermissionReviewer,
  ToolAuthorization,
  ToolPermissionRequest,
} from "../../packages/core/tool-permissions/types.ts"
import type { PiPermissionHandler, PiPort, PiPortEvent, PiPromptInput } from "../../packages/core/pi-port.ts"

const directories: string[] = []
const model: ModelReference = { providerId: "test", modelId: "model", api: "anthropic-messages" }
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

class PermissionPi implements PiPort {
  handler: PiPermissionHandler | undefined
  listeners = new Set<(event: PiPortEvent) => void>()
  authorization: ToolAuthorization | undefined
  create = async () => model
  restore = async () => model
  refreshView = async () => {}
  switchView = async () => model
  generateSessionTitle = async () => "标题"
  abort = async () => {}
  listModels = async () => [{ ...model, name: "模型", available: true }]
  reloadModelConfig = async () => {}
  setModel = async () => model
  listAuthProviders = async () => []
  loginApiKey = async () => {}
  answerAuthPrompt = () => {}
  cancelAuth = () => {}
  dispose = async () => {}
  setPermissionHandler(handler: PiPermissionHandler | undefined) {
    this.handler = handler
  }
  permissionReviewer(): AiPermissionReviewer {
    return { review: async () => ({ type: "needHumanReview", reason: "请用户确认" }) }
  }
  subscribe(listener: (event: PiPortEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async prompt(input: PiPromptInput) {
    const request: ToolPermissionRequest = {
      sessionId: input.sessionId ?? "",
      turnId: input.turnId,
      toolCallId: "call",
      toolName: "unknown",
      arguments: { value: 1 },
      declaredIntent: "执行未知工具",
      cwd: process.cwd(),
      mode: input.permissionMode ?? "hybrid",
    }
    this.authorization = await this.handler?.(request)
  }
}

test("Core发布人工审批并只接受一次答复", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-permission-flow-"))
  directories.push(root)
  const pi = new PermissionPi()
  const core = new AizenCore({ cwd: root, store: new SessionStore(join(root, "sessions")), pi })
  await core.dispatch({ type: "create_session", model, viewId: null, permissionMode: "hybrid" })
  const sending = core.dispatch({ type: "send_prompt", text: "执行" })
  for (let attempt = 0; attempt < 50 && !core.getSnapshot().pendingPermissionRequests?.length; attempt++)
    await Bun.sleep(2)
  const request = core.getSnapshot().pendingPermissionRequests?.[0]
  expect(request?.toolName).toBe("unknown")
  expect(
    await core.dispatch({ type: "answer_permission_request", requestId: request?.requestId ?? "", decision: "deny" }),
  ).toEqual({ ok: true })
  expect(await sending).toEqual({ ok: true })
  expect(pi.authorization).toMatchObject({ type: "deny", source: "human" })
  expect(
    await core.dispatch({
      type: "answer_permission_request",
      requestId: request?.requestId ?? "",
      decision: "approve",
    }),
  ).toMatchObject({ ok: false })
  await core.dispose()
})
