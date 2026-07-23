import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import { projectDirectoryName } from "../../packages/core/paths.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { createChatView } from "../../packages/tui-kit/chat-view.ts"
import { createChatEditor } from "../../packages/tui-kit/editor.ts"
import { promptLine } from "../../packages/tui-kit/prompt.ts"
import { createAizenRenderer, destroyRenderer } from "../../packages/tui-kit/renderer.ts"
import { selectItem } from "../../packages/tui-kit/selector.ts"

export type InteractiveAppOptions = { cwd: string; dataDirectory: string }

export async function runInteractiveApp(options: InteractiveAppOptions): Promise<void> {
  const renderer = await createAizenRenderer()
  const pi = await PiSessionRuntime.create({
    authPath: join(options.dataDirectory, "auth.json"),
    modelsPath: join(options.dataDirectory, "models.json"),
  })
  const store = new SessionStore(join(options.dataDirectory, "sessions", projectDirectoryName(options.cwd)))
  const core = new AizenCore({ cwd: options.cwd, store, pi })
  const view = createChatView(renderer)
  let exiting = false
  let action = Promise.resolve()

  const quit = () => {
    exiting = true
  }
  const runAction = (operation: () => Promise<unknown>) => {
    action = action.then(operation).then(
      () => {},
      () => {},
    )
  }
  const editor = createChatEditor(renderer, {
    onSubmit: (value) => {
      if (value === "/quit") quit()
      else if (value === "/new") runAction(createSession)
      else if (value === "/sessions") runAction(chooseSession)
      else if (value === "/model")
        runAction(async () => {
          const model = await chooseModel()
          if (model && core.getSnapshot().currentSessionId) await core.dispatch({ type: "set_model", model })
        })
      else runAction(() => core.dispatch({ type: "send_prompt", text: value }))
    },
    onAbort: () => void core.dispatch({ type: "abort" }),
    onQuit: quit,
  })

  const unsubscribe = core.subscribe((event) => {
    if (event.type === "snapshot") {
      view.update(event.snapshot)
      editor.setBusy(event.snapshot.status !== "idle")
    } else {
      editor.input.blur()
      void promptLine(renderer, `auth-${event.promptId}`, `${event.message}: `, {
        mask: event.promptType === "secret",
        onCancel: () => void core.dispatch({ type: "cancel_auth" }),
      }).then(async (value) => {
        if (value) await core.dispatch({ type: "answer_auth_prompt", promptId: event.promptId, value })
        editor.input.focus()
      })
    }
  })

  async function chooseModel() {
    await core.dispatch({ type: "list_models" })
    let models = core.getSnapshot().models.filter((model) => model.available)
    if (models.length === 0) {
      await core.dispatch({ type: "list_auth_providers" })
      const providers = core.getSnapshot().authProviders.filter((provider) => provider.supportsApiKey)
      const provider = await selectItem(
        renderer,
        "provider-selector",
        providers.map((item) => ({
          name: item.name,
          description: item.configured ? "已配置" : "需要 API 密钥",
          value: item.id,
        })),
      )
      if (!provider) return undefined
      const login = await core.dispatch({ type: "login_api_key", providerId: provider })
      if (!login.ok) return undefined
      await core.dispatch({ type: "list_models" })
      models = core.getSnapshot().models.filter((model) => model.available)
    }
    const selected = await selectItem(
      renderer,
      "model-selector",
      models.map((model) => ({ name: model.name, description: `${model.providerId}/${model.modelId}`, value: model })),
    )
    return selected
  }

  async function createSession() {
    const model = await chooseModel()
    if (model) await core.dispatch({ type: "create_session", model })
  }

  async function chooseSession() {
    await core.dispatch({ type: "list_sessions" })
    const sessions = core.getSnapshot().sessions
    if (sessions.length === 0) return createSession()
    const selected = await selectItem(renderer, "session-selector", [
      { name: "新建会话", description: "使用所选模型开始空白会话", value: "__new__" },
      ...sessions.map((session) => ({
        name: session.preview,
        description: session.updatedAt,
        value: session.sessionId,
      })),
    ])
    if (selected === "__new__") await createSession()
    else if (selected) await core.dispatch({ type: "open_session", sessionId: selected })
  }

  try {
    await chooseSession()
    while (!exiting) {
      await Bun.sleep(50)
    }
  } finally {
    unsubscribe()
    editor.destroy()
    try {
      await action
      await core.dispose()
    } finally {
      destroyRenderer(renderer)
    }
  }
}
