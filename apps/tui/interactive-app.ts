import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import { ModelConfigStore } from "../../packages/core/model-config-store.ts"
import { projectDirectoryName } from "../../packages/core/paths.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { createChatView } from "../../packages/tui-kit/chat-view.ts"
import { createChatEditor } from "../../packages/tui-kit/editor.ts"
import { statusBarView } from "../../packages/tui-kit/status-bar.ts"

import { promptLine } from "../../packages/tui-kit/prompt.ts"
import { createAizenRenderer, destroyRenderer } from "../../packages/tui-kit/renderer.ts"
import { selectItem } from "../../packages/tui-kit/selector.ts"

export type InteractiveAppOptions = { cwd: string; dataDirectory: string }

const authPromptLabels: Record<string, string> = {
  "Enter AWS profile name": "AWS 配置名称",
  "Configure AWS credentials, then press Enter to continue": "配置 AWS 凭据后按 Enter 继续",
  "Enter Google Cloud project ID": "Google Cloud 项目 ID",
  "Enter Google Cloud location": "Google Cloud 区域",
  "Enter service account credentials file path": "服务账号凭据文件路径",
}

const authOptionLabels: Record<string, string> = {
  "Bearer token": "Bearer 令牌",
  "AWS profile": "AWS 配置",
  "Existing AWS credential chain": "现有 AWS 凭据链",
  "Google Cloud API key": "Google Cloud API 密钥",
  "Application Default Credentials": "应用默认凭据",
  "Service account credentials file": "服务账号凭据文件",
}

export async function runInteractiveApp(options: InteractiveAppOptions): Promise<void> {
  const renderer = await createAizenRenderer()
  const pi = await PiSessionRuntime.create({
    authPath: join(options.dataDirectory, "auth.json"),
    modelsPath: join(options.dataDirectory, "models.json"),
  })
  const store = new SessionStore(join(options.dataDirectory, "sessions", projectDirectoryName(options.cwd)))
  const core = new AizenCore({
    cwd: options.cwd,
    store,
    pi,
    modelConfigStore: new ModelConfigStore(join(options.dataDirectory, "models.json")),
  })
  const view = createChatView(renderer)
  const interactionController = new AbortController()
  let exiting = false
  let action = Promise.resolve()
  let authProviderName: string | undefined
  let interactionDepth = 0

  const quit = () => {
    if (exiting) return
    exiting = true
    interactionController.abort()
    const status = core.getSnapshot().status
    if (status === "authenticating") core.dispatch({ type: "cancel_auth" }).catch(() => {})
    if (status === "running" || status === "aborting") core.dispatch({ type: "abort" }).catch(() => {})
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
      else if (value === "/fold") runAction(chooseFold)
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
  editor.setInputVisible(false)

  const updateStatusBar = () => {
    const statusBar = statusBarView(core.getSnapshot())
    editor.setStatus(statusBar.session)
    editor.setShortcuts(statusBar.shortcuts)
  }
  updateStatusBar()

  const beginInteraction = () => {
    interactionDepth += 1
    editor.setInputVisible(false)
  }
  const endInteraction = () => {
    interactionDepth -= 1
    const snapshot = core.getSnapshot()
    editor.setInputVisible(
      !exiting && interactionDepth === 0 && snapshot.status === "idle" && !!snapshot.currentSessionId,
    )
  }

  const unsubscribe = core.subscribe((event) => {
    if (event.type === "snapshot") {
      view.update(event.snapshot)
      const statusBar = statusBarView(event.snapshot)
      editor.setStatus(statusBar.session)
      editor.setShortcuts(statusBar.shortcuts)
      editor.setBusy(event.snapshot.status !== "idle")

      editor.setInputVisible(
        !exiting && interactionDepth === 0 && event.snapshot.status === "idle" && !!event.snapshot.currentSessionId,
      )
    } else if (event.promptType === "select") {
      editor.input.blur()
      void selectItem(
        renderer,
        `auth-${event.promptId}`,
        (event.options ?? []).map((option) => ({
          name: authOptionLabels[option.label] ?? option.label,
          description: option.description ?? "",
          value: option.id,
        })),
        {
          title: `选择 ${authProviderName ?? "服务商"} 认证方式`,
          signal: interactionController.signal,
        },
      ).then(async (value) => {
        if (value)
          await core.dispatch({
            type: "answer_auth_prompt",
            promptId: event.promptId,
            value,
          })
        else await core.dispatch({ type: "cancel_auth" })
      })
    } else {
      editor.input.blur()
      const label =
        event.promptType === "secret"
          ? `${authProviderName ?? "服务商"} 密钥或令牌：`
          : `${authPromptLabels[event.message] ?? event.message}：`
      void promptLine(renderer, `auth-${event.promptId}`, label, {
        mask: event.promptType === "secret",
        signal: interactionController.signal,
        onCancel: () => void core.dispatch({ type: "cancel_auth" }),
      }).then(async (value) => {
        if (value)
          await core.dispatch({
            type: "answer_auth_prompt",
            promptId: event.promptId,
            value,
          })
      })
    }
  })

  async function chooseFold() {
    beginInteraction()
    try {
      while (!exiting) {
        const selected = await selectItem<
          { type: "toggle"; id: string } | { type: "collapse_tools" } | { type: "expand_all" }
        >(
          renderer,
          "fold-selector",
          [
            {
              name: "折叠全部工具组",
              description: "收起所有连续工具调用",
              value: { type: "collapse_tools" },
            },
            {
              name: "全部展开",
              description: "展开助手回复和工具组",
              value: { type: "expand_all" },
            },
            ...view.getCollapseItems().map((item) => ({
              name: `[${item.collapsed ? "折叠" : "展开"}] ${item.name}`,
              description: item.description,
              value: { type: "toggle" as const, id: item.id },
            })),
          ],
          {
            title: "管理折叠（Enter 切换，Esc 返回）",
            signal: interactionController.signal,
          },
        )
        if (!selected) return
        if (selected.type === "toggle") view.toggleCollapse(selected.id)
        else if (selected.type === "collapse_tools") view.collapseAll(true, "tool_group")
        else view.collapseAll(false)
      }
    } finally {
      endInteraction()
    }
  }

  async function chooseModel() {
    beginInteraction()
    try {
      const authenticateProvider = async () => {
        while (!exiting) {
          await core.dispatch({ type: "list_auth_providers" })
          const providers = core.getSnapshot().authProviders.filter((provider) => provider.supportsApiKey)
          const provider = await selectItem(
            renderer,
            "provider-selector",
            providers.map((item) => ({
              name: item.name,
              description: item.configured ? "已配置" : "需要认证",
              value: item.id,
            })),
            { title: "选择服务商", signal: interactionController.signal },
          )
          if (!provider) return false
          authProviderName = providers.find((item) => item.id === provider)?.name
          const login = await core.dispatch({
            type: "login_api_key",
            providerId: provider,
          })
          authProviderName = undefined
          if (login.ok) return true
        }
        return false
      }
      while (!exiting) {
        const listed = await core.dispatch({ type: "list_models" })
        if (!listed.ok) return undefined
        const models = core.getSnapshot().models.filter((model) => model.available)
        if (models.length === 0) {
          if (!(await authenticateProvider())) return undefined
          continue
        }
        const selected = await selectItem<(typeof models)[number] | "__authenticate__">(
          renderer,
          "model-selector",
          [
            ...models.map((model) => ({
              name: model.name,
              description: `${model.providerId}/${model.modelId}`,
              value: model,
            })),
            {
              name: "认证其它服务商",
              description: "为内置或 models.json 中的服务商保存认证信息",
              value: "__authenticate__" as const,
            },
          ],
          { title: "选择模型", signal: interactionController.signal },
        )
        if (selected === "__authenticate__") {
          await authenticateProvider()
          continue
        }
        return selected
      }
      return undefined
    } finally {
      authProviderName = undefined
      endInteraction()
    }
  }

  async function createSession() {
    const model = await chooseModel()
    if (model) await core.dispatch({ type: "create_session", model })
  }

  async function chooseSession() {
    beginInteraction()
    try {
      await core.dispatch({ type: "list_sessions" })
      const sessions = core.getSnapshot().sessions
      if (sessions.length === 0) return createSession()
      const selected = await selectItem(
        renderer,
        "session-selector",
        [
          {
            name: "新建会话",
            description: "使用所选模型开始空白会话",
            value: "__new__",
          },
          ...sessions.map((session) => ({
            name: session.preview,
            description: session.updatedAt,
            value: session.sessionId,
          })),
        ],
        { title: "选择会话", signal: interactionController.signal },
      )
      if (selected === "__new__") await createSession()
      else if (selected) await core.dispatch({ type: "open_session", sessionId: selected })
    } finally {
      endInteraction()
    }
  }

  try {
    await chooseSession()
    if (!core.getSnapshot().currentSessionId) quit()
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
