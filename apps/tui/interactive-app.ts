import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import { AppPreferencesStore } from "../../packages/core/app-preferences-store.ts"
import type {
  ConfigurableApi,
  EditableModelConfig,
  EditableProviderConfig,
  ModelConfigEntry,
  ModelCostConfig,
  ProviderConfigEntry,
} from "../../packages/core/model-config-store.ts"
import { ModelConfigStore } from "../../packages/core/model-config-store.ts"
import { projectDirectoryName } from "../../packages/core/paths.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import type { CorePort } from "../../packages/core/types.ts"
import { ViewStore } from "../../packages/core/view-store.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { promptAuthInput } from "../../packages/tui-kit/auth-input.ts"
import { createChatView } from "../../packages/tui-kit/chat-view.ts"
import { createChatEditor } from "../../packages/tui-kit/editor.ts"
import { selectEditableItem } from "../../packages/tui-kit/editable-selector.ts"
import { editInline } from "../../packages/tui-kit/inline-input.ts"
import { modelProviderChoices, unconfiguredAuthProviders } from "../../packages/tui-kit/model-selection.ts"
import { selectMultiple } from "../../packages/tui-kit/multi-select.ts"
import { OverlayManager } from "../../packages/tui-kit/overlay-manager.ts"
import {
  createAizenRenderer,
  destroyRenderer,
  setAizenTerminalTitle,
  type TuiRenderer,
} from "../../packages/tui-kit/renderer.ts"
import { selectRichItem } from "../../packages/tui-kit/rich-selector.ts"
import { selectItem } from "../../packages/tui-kit/selector.ts"
import { statusBarView } from "../../packages/tui-kit/status-bar.ts"
import { editThinkingConfiguration } from "../../packages/tui-kit/thinking-editor.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"

import { ActionQueue, dispatchOrPresent } from "./action-runner.ts"
import { isTuiCommand, tuiCommands } from "./commands.ts"
import { openDirectory, openExternalEditor } from "./external-open.ts"
import { type SessionSettingsDraft, sessionSettingsItems } from "./session-settings.ts"
import { viewSelectionItems } from "./view-flow.ts"

const createViewValue = ":create-view"
const manageViewsValue = ":manage-views"

export type InteractiveAppOptions = {
  cwd: string
  dataDirectory: string
  testing?: { renderer: TuiRenderer; core: CorePort }
}

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
  const renderer = options.testing?.renderer ?? (await createAizenRenderer())
  const pi = options.testing
    ? undefined
    : await PiSessionRuntime.create({
        authPath: join(options.dataDirectory, "auth.json"),
        modelsPath: join(options.dataDirectory, "models.json"),
      })
  const store = new SessionStore(join(options.dataDirectory, "sessions", projectDirectoryName(options.cwd)), {
    indexPath: join(options.dataDirectory, "cache", "session-index.json"),
  })
  const core =
    options.testing?.core ??
    new AizenCore({
      cwd: options.cwd,
      store,
      pi: pi as PiSessionRuntime,
      modelConfigStore: new ModelConfigStore(join(options.dataDirectory, "models.json")),
      preferencesStore: new AppPreferencesStore(join(options.dataDirectory, "preferences.json")),
      views: new ViewStore(join(options.dataDirectory, "views.json")),
    })
  const view = createChatView(renderer)
  const interactionController = new AbortController()
  const overlays = new OverlayManager(renderer)
  let exiting = false
  let authProviderName: string | undefined
  let interactionDepth = 0
  let terminalTitle = ""

  const syncTerminalTitle = (snapshot: ReturnType<typeof core.getSnapshot>) => {
    const identity = snapshot.currentSessionId
      ? snapshot.currentSessionName || snapshot.currentSessionId
      : "AizenAssistant"
    const next = identity === "AizenAssistant" ? identity : `${identity} · AizenAssistant`
    if (next === terminalTitle) return
    terminalTitle = next
    setAizenTerminalTitle(renderer, next)
  }

  const quit = () => {
    if (exiting) return
    exiting = true
    interactionController.abort()
    const status = core.getSnapshot().status
    if (status === "authenticating") core.dispatch({ type: "cancel_auth" }).catch(() => {})
    if (status === "running" || status === "aborting") core.dispatch({ type: "abort" }).catch(() => {})
  }
  overlays.setCtrlCHandler(quit)
  const showError = async (title: string, error: string) => {
    if (exiting) return
    if (overlays.depth > 0) overlays.setCurrentError(`${title}：${error}`)
    else {
      overlays.setCurrentError(`${title}：${error}`)
      editor.setError(`${title}：${error}`)
    }
  }
  const actions = new ActionQueue(showError)
  const runAction = (operation: () => Promise<unknown>) => actions.run(operation)
  const dispatchWithError = (command: Parameters<typeof core.dispatch>[0], title: string) =>
    dispatchOrPresent(core, command, title, showError)
  const editor = createChatEditor(
    renderer,
    {
      onSubmit: (value) => {
        if (!isTuiCommand(value))
          runAction(() => dispatchWithError({ type: "send_prompt", text: value }, "发送消息失败"))
        else if (value === "/quit") quit()
        else if (value === "/new") runAction(createSession)
        else if (value === "/sessions") runAction(chooseSession)
        else if (value === "/rewind") runAction(() => changeConversation("rewind"))
        else if (value === "/fork") runAction(() => changeConversation("fork"))
        else if (value === "/rename") runAction(renameCurrentSession)
        else if (value === "/views") runAction(manageViews)
        else if (value === "/view" || value === "/model") runAction(() => openSessionSettings("existing"))
        else if (value === "/fold") runAction(chooseFold)
        else if (value === "/models") runAction(manageModels)
      },
      onAbort: () => void core.dispatch({ type: "abort" }),
      onQuit: quit,
    },
    overlays,
    tuiCommands,
  )
  editor.setInputVisible(false)

  const updateStatusBar = () => {
    const snapshot = core.getSnapshot()
    syncTerminalTitle(snapshot)
    const statusBar = statusBarView(snapshot)
    editor.setStatus(statusBar.session)
    editor.setShortcuts(statusBar.shortcuts)
    editor.setSessionTitle(
      snapshot.currentSessionId
        ? { name: snapshot.currentSessionName ?? "", sessionId: snapshot.currentSessionId }
        : undefined,
    )
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
      syncTerminalTitle(event.snapshot)
      const statusBar = statusBarView(event.snapshot)
      editor.setStatus(statusBar.session)
      editor.setShortcuts(statusBar.shortcuts)
      editor.setSessionTitle(
        event.snapshot.currentSessionId
          ? { name: event.snapshot.currentSessionName ?? "", sessionId: event.snapshot.currentSessionId }
          : undefined,
      )
      editor.setBusy(event.snapshot.status !== "idle")

      editor.setInputVisible(
        !exiting && interactionDepth === 0 && event.snapshot.status === "idle" && !!event.snapshot.currentSessionId,
      )
    } else if (event.promptType === "select") {
      editor.input.blur()
      void selectItem(
        overlays,
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
      void promptAuthInput(overlays, `auth-${event.promptId}`, `${authProviderName ?? "服务商"}认证`, label, {
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

  async function createViewWithName(name: string): Promise<void> {
    if (!name.trim()) return
    const result = await dispatchWithError({ type: "create_view", name: name.trim() }, "创建视图失败")
    if (!result.ok) return
    const created = core.getSnapshot().views.find((item) => item.name === name.trim())
    if (!created) return
    await showError(
      "视图已创建",
      `请编辑 SYSTEM.md：${join(created.directory, "SYSTEM.md")}；AGENTS.md：${join(created.directory, "AGENTS.md")}；Skills：${join(created.directory, "skills")}`,
    )
  }

  async function chooseView(): Promise<string | null | undefined> {
    beginInteraction()
    try {
      while (!exiting) {
        const listed = await dispatchWithError({ type: "list_views" }, "读取视图失败")
        if (!listed.ok) return undefined
        const selected = await selectEditableItem<string | null>(
          overlays,
          "view-selector",
          () => [
            ...viewSelectionItems(core.getSnapshot().views),
            {
              name: "新建视图",
              description: "在当前选项内输入名称并创建视图模板",
              value: createViewValue,
              edit: {
                label: "新建视图  ",
                value: "",
                validate: (value) => (value.trim() ? undefined : "视图名称不能为空"),
                save: createViewWithName,
              },
            },
            { name: "管理视图", description: "编辑、移除或删除视图", value: manageViewsValue },
          ],
          { title: "选择视图", signal: interactionController.signal },
        )
        if (selected === manageViewsValue) {
          await manageViews()
          continue
        }
        return selected
      }
      return undefined
    } finally {
      endInteraction()
    }
  }

  async function manageViews() {
    beginInteraction()
    try {
      while (!exiting) {
        const listed = await dispatchWithError({ type: "list_views" }, "读取视图失败")
        if (!listed.ok) return
        const selected = await selectEditableItem(
          overlays,
          "views-manager",
          () => [
            { name: "刷新", description: "重新读取 views.json 和目录状态", value: "__refresh__" },
            {
              name: "创建视图模板",
              description: "在当前选项内输入名称并创建 AGENTS.md 和 skills 目录",
              value: "__create__",
              edit: {
                label: "创建视图模板  ",
                value: "",
                validate: (value) => (value.trim() ? undefined : "视图名称不能为空"),
                save: createViewWithName,
              },
            },
            ...core.getSnapshot().views.map((item) => ({
              name: `${item.valid ? "✓" : "!"} ${item.name}`,
              description: `${item.id} · ${item.error ?? item.directory}`,
              value: item.id,
            })),
          ],
          { title: "管理视图（选择视图后进入操作菜单）", signal: interactionController.signal },
        )
        if (!selected) return
        if (selected === "__refresh__") continue
        if (selected === "__create__") continue
        await manageView(selected)
      }
    } finally {
      endInteraction()
    }
  }

  async function manageView(viewId: string) {
    const viewItem = core.getSnapshot().views.find((item) => item.id === viewId)
    if (!viewItem) return
    const action = await selectEditableItem(
      overlays,
      "view-action",
      () => [
        {
          name: `名称  ${viewItem.name}`,
          description: "视图显示名称",
          value: "edited",
          edit: {
            label: "名称  ",
            value: viewItem.name,
            validate: (value) => (value.trim() ? undefined : "视图名称不能为空"),
            save: async (value) => {
              await dispatchWithError({ type: "update_view", viewId, name: value.trim() }, "更新视图失败")
              viewItem.name = value.trim()
            },
          },
        },
        {
          name: `目录路径  ${viewItem.path}`,
          description: "视图资源所在目录",
          value: "edited",
          edit: {
            label: "目录路径  ",
            value: viewItem.path,
            validate: (value) => (value.trim() ? undefined : "目录路径不能为空"),
            save: async (value) => {
              await dispatchWithError({ type: "update_view", viewId, path: value.trim() }, "更新视图失败")
              viewItem.path = value.trim()
            },
          },
        },
        { name: "编辑 SYSTEM.md", description: "不存在时自动创建", value: "system" },
        { name: "编辑 AGENTS.md", description: "不存在时自动创建", value: "agents" },
        { name: "打开 Skills 目录", description: viewItem.directory, value: "skills" },
        { name: "移除注册", description: "保留视图目录和文件", value: "remove" },
        { name: "删除视图目录", description: "同时删除注册和目录，需要再次确认", value: "delete" },
      ],
      { title: `管理视图 · ${viewItem.name}`, signal: interactionController.signal },
    )
    if (action === "edited") return manageView(viewId)
    if (action === "system" || action === "agents") {
      const name = action === "system" ? "SYSTEM.md" : "AGENTS.md"
      const ensured = await dispatchWithError({ type: "ensure_view_file", viewId, name }, "创建视图文件失败")
      if (ensured.ok) await openExternalEditor(join(viewItem.directory, name))
    } else if (action === "skills") {
      await openDirectory(join(viewItem.directory, "skills"))
    } else if (action === "remove") {
      await dispatchWithError({ type: "remove_view", viewId }, "移除视图失败")
    } else if (action === "delete") {
      const confirmed = await selectItem(
        overlays,
        "view-delete-confirm",
        [
          { name: "确认删除", description: viewItem.directory, value: true },
          { name: "取消", description: "不做修改", value: false },
        ],
        { title: `永久删除视图 ${viewItem.name}？`, signal: interactionController.signal },
      )
      if (confirmed) await dispatchWithError({ type: "remove_view", viewId, deleteDirectory: true }, "删除视图失败")
    }
  }

  async function chooseFold() {
    beginInteraction()
    try {
      let draft = view.getFoldPreferences()
      const fields = [
        { key: "userTurns", name: "用户消息" },
        { key: "assistantTurns", name: "助手回复" },
        { key: "thinkingTurns", name: "思考过程" },
        { key: "toolGroupTurns", name: "工具组" },
        { key: "toolDetailTurns", name: "工具详情" },
      ] as const
      while (!exiting) {
        const selected = await selectEditableItem<"reset" | "apply">(
          overlays,
          "fold-selector",
          () => [
            ...fields.map((field) => ({
              name: `${field.name.padEnd(6, "　")} ${draft[field.key] === 0 ? "全部展开" : `最近 ${draft[field.key]} 轮`}`,
              description: field.key === "toolDetailTurns" ? "不能超过工具组；0 表示全部展开" : "0 表示全部展开",
              value: "apply" as const,
              edit: {
                label: `${field.name}  `,
                value: String(draft[field.key]),
                validate: (value: string) => (/^\d+$/.test(value) ? undefined : "请输入大于或等于 0 的整数"),
                save: (value: string) => {
                  const parsed = Number(value)
                  if (!Number.isSafeInteger(parsed)) return
                  draft = { ...draft, [field.key]: parsed }
                  if (
                    field.key === "toolGroupTurns" &&
                    draft.toolGroupTurns !== 0 &&
                    (draft.toolDetailTurns === 0 || draft.toolDetailTurns > draft.toolGroupTurns)
                  )
                    draft.toolDetailTurns = draft.toolGroupTurns
                  if (
                    field.key === "toolDetailTurns" &&
                    (draft.toolDetailTurns === 0
                      ? draft.toolGroupTurns !== 0
                      : draft.toolGroupTurns !== 0 && draft.toolDetailTurns > draft.toolGroupTurns)
                  )
                    draft.toolGroupTurns = draft.toolDetailTurns
                },
              },
            })),
            { name: "恢复默认", description: "恢复内置折叠范围", value: "reset" as const },
            { name: "应用并返回", description: "保存设置并全量回放会话", value: "apply" as const },
          ],
          { title: "折叠设置", signal: interactionController.signal },
        )
        if (!selected) return
        if (selected === "reset") {
          draft = { userTurns: 0, assistantTurns: 3, thinkingTurns: 1, toolGroupTurns: 1, toolDetailTurns: 1 }
          continue
        }
        if (selected === "apply") {
          const result = await dispatchWithError({ type: "save_fold_preferences", fold: draft }, "保存折叠设置失败")
          if (result.ok) view.setFoldPreferences(draft)
          return
        }
      }
    } finally {
      endInteraction()
    }
  }

  async function chooseModel() {
    beginInteraction()
    try {
      const authenticateProvider = async (providerId?: string): Promise<string | undefined> => {
        while (!exiting) {
          const providersResult = await dispatchWithError({ type: "list_auth_providers" }, "读取认证供应商失败")
          if (!providersResult.ok) return undefined
          const providers = core.getSnapshot().authProviders
          const selectedProvider = providerId
            ? providers.find((provider) => provider.id === providerId)
            : await selectItem(
                overlays,
                "provider-selector",
                unconfiguredAuthProviders(providers).map((item) => ({
                  name: item.name,
                  description: "需要认证",
                  value: item,
                })),
                { title: "认证其它供应商", signal: interactionController.signal },
              )
          if (!selectedProvider) return undefined
          authProviderName = selectedProvider.name
          const login = await dispatchWithError(
            { type: "login_api_key", providerId: selectedProvider.id },
            "供应商认证失败",
          )
          authProviderName = undefined
          if (login.ok) return selectedProvider.id
          if (providerId) return undefined
        }
        return undefined
      }

      let preferredProviderId: string | undefined
      while (!exiting) {
        const listed = await dispatchWithError({ type: "list_models" }, "读取模型失败")
        if (!listed.ok) return undefined
        const authListed = await dispatchWithError({ type: "list_auth_providers" }, "读取认证供应商失败")
        if (!authListed.ok) return undefined
        const configLoaded = await dispatchWithError({ type: "load_model_config" }, "读取模型配置失败")
        if (!configLoaded.ok) return undefined
        const snapshot = core.getSnapshot()
        const providers = modelProviderChoices(
          snapshot.models,
          snapshot.authProviders,
          snapshot.modelConfig?.providers ?? [],
        )
        const preferred = preferredProviderId
          ? providers.find((provider) => provider.id === preferredProviderId)
          : undefined
        preferredProviderId = undefined
        const provider =
          preferred ??
          (await selectItem<(typeof providers)[number] | "__authenticate__" | "__manage__">(
            overlays,
            "model-provider-selector",
            [
              ...providers.map((item) => ({
                name: item.name,
                description: item.configured ? `${item.models.length} 个可用模型` : "需要认证（认证前不显示模型）",
                value: item,
              })),
              {
                name: "管理供应商和模型",
                description: "新增、编辑或删除 models.json 配置",
                value: "__manage__" as const,
              },
              {
                name: "认证其它供应商",
                description: "显示尚未认证的供应商",
                value: "__authenticate__" as const,
              },
            ],
            { title: "选择供应商", signal: interactionController.signal },
          ))
        if (provider === "__manage__") {
          preferredProviderId = await manageModels("select")
          continue
        }
        if (provider === "__authenticate__") {
          preferredProviderId = await authenticateProvider()
          continue
        }
        if (!provider) return undefined

        if (!provider.configured) {
          const action = await selectItem<"authenticate" | "manage">(
            overlays,
            "unconfigured-provider",
            [
              { name: "立即认证", description: "认证成功后选择模型", value: "authenticate" },
              { name: "管理供应商配置", description: "编辑地址、API 和模型", value: "manage" },
            ],
            { title: `${provider.name} 尚未认证`, signal: interactionController.signal },
          )
          if (action === "authenticate") preferredProviderId = await authenticateProvider(provider.id)
          else if (action === "manage") preferredProviderId = await manageModels("select", provider.id)
          continue
        }

        if (provider.models.length === 0) {
          const action = await selectItem<"manage" | "authenticate">(
            overlays,
            "empty-provider",
            [
              { name: "新增或管理模型", description: "当前没有可用模型", value: "manage" },
              { name: "重新认证", description: "更新供应商认证信息", value: "authenticate" },
            ],
            { title: `${provider.name} 没有可用模型`, signal: interactionController.signal },
          )
          if (action === "manage") preferredProviderId = await manageModels("select", provider.id)
          else if (action === "authenticate") preferredProviderId = await authenticateProvider(provider.id)
          continue
        }

        const selected = await selectItem<(typeof provider.models)[number] | "__manage__" | "__authenticate__">(
          overlays,
          "model-selector",
          [
            ...provider.models.map((model) => ({
              name: model.name,
              description: `${model.providerId}/${model.modelId}`,
              value: model,
            })),
            { name: "管理此供应商", description: "编辑供应商和模型", value: "__manage__" as const },
            { name: "重新认证", description: "更新认证信息", value: "__authenticate__" as const },
          ],
          { title: `选择模型 · ${provider.name}`, signal: interactionController.signal },
        )
        if (selected === "__manage__") {
          preferredProviderId = await manageModels("select", provider.id)
          continue
        }
        if (selected === "__authenticate__") {
          preferredProviderId = await authenticateProvider(provider.id)
          continue
        }
        if (selected) {
          const levels = [
            ...(selected.offThinkingLevel === undefined ? [] : [selected.offThinkingLevel]),
            ...(selected.thinkingLevels ?? []),
          ]
          if (levels.length <= 1) return selected
          const thinkingLevel = await selectItem<string>(
            overlays,
            "thinking-level-selector",
            levels.map((level) => ({
              name: level === selected.offThinkingLevel ? `关闭思考 · ${level}` : level,
              description: level === selected.offThinkingLevel ? "关闭档位" : "思考档位",
              value: level,
            })),
            { title: "选择思考档位", signal: interactionController.signal },
          )
          if (thinkingLevel) return { ...selected, thinkingLevel }
        }
      }
      return undefined
    } finally {
      authProviderName = undefined
      endInteraction()
    }
  }

  async function chooseApi(title: string, inherited = false): Promise<ConfigurableApi | undefined | "cancel"> {
    const snapshot = core.getSnapshot().modelConfig
    if (!snapshot) return "cancel"
    const value = await selectItem<ConfigurableApi | "inherit">(
      overlays,
      `api-selector-${crypto.randomUUID()}`,
      [
        ...(inherited ? [{ name: "继承供应商", description: "", value: "inherit" as const }] : []),
        ...snapshot.apiChoices.map((item) => ({ name: item, description: "", value: item })),
      ],
      { title, signal: interactionController.signal },
    )
    return value === undefined ? "cancel" : value === "inherit" ? undefined : value
  }

  async function editProvider(existing?: ProviderConfigEntry): Promise<EditableProviderConfig | undefined> {
    const draft: {
      id?: string
      name?: string
      baseUrl?: string
      api?: ConfigurableApi
      authHeader?: boolean
    } = existing
      ? {
          id: existing.id,
          name: existing.name,
          baseUrl: existing.baseUrl,
          ...(existing.api ? { api: existing.api } : {}),
          authHeader: existing.authHeader,
        }
      : { name: "", baseUrl: "https://", authHeader: true }
    while (!exiting) {
      const action = await selectEditableItem<"api" | "authHeader" | "save">(
        overlays,
        "provider-editor",
        () => [
          {
            name: `供应商 ID       ${draft.id ?? "未设置"}`,
            description: existing ? "创建后不可修改" : "小写字母、数字、点、下划线或短横线",
            value: "save",
            disabled: !!existing,
            disabledReason: "创建后不可修改",
            edit: {
              label: "供应商 ID       ",
              value: draft.id ?? "",
              validate: (value) => (/^[a-z0-9._-]+$/.test(value) ? undefined : "供应商 ID 格式无效"),
              save: (value) => {
                draft.id = value.trim()
              },
            },
          },
          {
            name: `显示名称        ${draft.name || "未设置"}`,
            description: "供应商显示名称",
            value: "save",
            edit: {
              label: "显示名称        ",
              value: draft.name ?? "",
              validate: (value) => (value.trim() ? undefined : "显示名称不能为空"),
              save: (value) => {
                draft.name = value.trim()
              },
            },
          },
          {
            name: `Base URL        ${draft.baseUrl || "未设置"}`,
            description: "供应商接口地址",
            value: "save",
            edit: {
              label: "Base URL        ",
              value: draft.baseUrl ?? "",
              validate: (value) => (value.trim() ? undefined : "Base URL 不能为空"),
              save: (value) => {
                draft.baseUrl = value.trim()
              },
            },
          },
          { name: `API             ${draft.api ?? "未设置"}`, description: "选择接口协议", value: "api" },
          {
            name: `Bearer 认证头   ${draft.authHeader ? "是" : "否"}`,
            description: "切换认证头格式",
            value: "authHeader",
          },
          { name: "保存", description: "校验并应用配置", value: "save" },
        ],
        { title: existing ? `编辑供应商 ${existing.id}` : "新增供应商", signal: interactionController.signal },
      )
      if (!action) return undefined
      if (action === "api") {
        const selected = await chooseApi("选择供应商 API")
        if (selected !== "cancel" && selected !== undefined) draft.api = selected
      } else if (action === "authHeader") draft.authHeader = !draft.authHeader
      else if (draft.id && draft.name && draft.baseUrl && draft.api && draft.authHeader !== undefined)
        return draft as EditableProviderConfig
    }
    return undefined
  }

  async function editCost(initial: ModelCostConfig): Promise<ModelCostConfig | undefined> {
    const draft = { ...initial }
    while (!exiting) {
      const selected = await selectEditableItem<"save">(
        overlays,
        "model-cost-editor",
        () => [
          ...(["input", "output", "cacheRead", "cacheWrite"] as const).map((key) => ({
            name: `${{ input: "输入价格", output: "输出价格", cacheRead: "Cache Read", cacheWrite: "Cache Write" }[key]}  ${draft[key]}`,
            description: "美元/百万 token",
            value: "save" as const,
            edit: {
              label: `${{ input: "输入价格  ", output: "输出价格  ", cacheRead: "Cache Read  ", cacheWrite: "Cache Write  " }[key]}`,
              value: String(draft[key]),
              validate: (value: string) => (Number.isFinite(Number(value)) ? undefined : "请输入有效数字"),
              save: (value: string) => {
                draft[key] = Number(value)
              },
            },
          })),
          { name: "完成", description: "保存价格并返回模型编辑页", value: "save" as const },
        ],
        { title: "编辑模型价格", signal: interactionController.signal },
      )
      if (!selected) return undefined
      if (selected === "save") return { ...draft }
    }
    return undefined
  }

  const positiveIntegerError = (value: string) => {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? undefined : "请输入大于 0 的整数"
  }

  async function editModel(existing?: ModelConfigEntry, copy = false): Promise<EditableModelConfig | undefined> {
    const config = core.getSnapshot().modelConfig
    if (!config) return undefined
    const draft: EditableModelConfig = {
      id: copy ? "" : (existing?.id ?? ""),
      name: existing?.name ?? "",
      ...(existing?.api ? { api: existing.api } : {}),
      ...(existing?.thinking
        ? {
            thinking: {
              ...(existing.thinking.disableThinkingLevel === undefined
                ? {}
                : { disableThinkingLevel: existing.thinking.disableThinkingLevel }),
              thinkingLevels: [...existing.thinking.thinkingLevels],
              defaultThinkingLevel: existing.thinking.defaultThinkingLevel,
            },
          }
        : {}),
      input: existing ? [...existing.input] : ["text"],
      contextWindow: existing?.contextWindow ?? 128000,
      maxTokens: existing?.maxTokens ?? 16384,
      cost: { ...(existing?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) },
    }
    while (!exiting) {
      const action = await selectEditableItem<"api" | "input" | "output" | "reasoning" | "cost" | "save">(
        overlays,
        "model-editor",
        () => [
          {
            name: `模型 ID          ${draft.id || "未设置"}`,
            description: existing && !copy ? "创建后不可修改" : "模型服务使用的 ID",
            value: "save",
            disabled: !!existing && !copy,
            disabledReason: "创建后不可修改",
            edit: {
              label: "模型 ID          ",
              value: draft.id,
              validate: (value) => (value.trim() ? undefined : "模型 ID 不能为空"),
              save: (value) => {
                draft.id = value.trim()
              },
            },
          },
          {
            name: `显示名称         ${draft.name || "未设置"}`,
            description: "模型显示名称",
            value: "save",
            edit: {
              label: "显示名称         ",
              value: draft.name,
              validate: (value) => (value.trim() ? undefined : "显示名称不能为空"),
              save: (value) => {
                draft.name = value.trim()
              },
            },
          },
          { name: `API              ${draft.api ?? "继承供应商"}`, description: "选择接口协议", value: "api" },
          { name: `输入模态         ${draft.input.join("、")}`, description: "多选", value: "input" },
          { name: "输出模态         当前 adapter 不支持配置", description: "查看扩展边界", value: "output" },
          {
            name: `思考档位         ${draft.thinking ? [draft.thinking.disableThinkingLevel, ...draft.thinking.thinkingLevels].filter(Boolean).join("、") : "不支持"}`,
            description: draft.thinking ? "关闭档位独立显示；最多六个思考档位" : "Enter 启用",
            value: "reasoning",
          },
          {
            name: `上下文窗口       ${draft.contextWindow}`,
            description: "模型最大上下文 token 数",
            value: "save",
            edit: {
              label: "上下文窗口       ",
              value: String(draft.contextWindow),
              validate: positiveIntegerError,
              save: (value) => {
                draft.contextWindow = Number(value)
              },
            },
          },
          {
            name: `最大输出 token   ${draft.maxTokens}`,
            description: "单次回复最大 token 数",
            value: "save",
            edit: {
              label: "最大输出 token   ",
              value: String(draft.maxTokens),
              validate: positiveIntegerError,
              save: (value) => {
                draft.maxTokens = Number(value)
              },
            },
          },
          {
            name: "价格",
            description: `输入 ${draft.cost.input} / 输出 ${draft.cost.output} / 读缓存 ${draft.cost.cacheRead} / 写缓存 ${draft.cost.cacheWrite}`,
            value: "cost",
          },
          { name: "保存", description: "校验并应用配置", value: "save" },
        ],
        { title: existing && !copy ? `编辑模型 ${existing.id}` : "新增模型", signal: interactionController.signal },
      )
      if (!action) return undefined
      if (action === "api") {
        const selected = await chooseApi("选择模型 API", true)
        if (selected !== "cancel") {
          if (selected === undefined) delete draft.api
          else draft.api = selected
        }
      } else if (action === "input") {
        const selected = await selectMultiple(
          overlays,
          `model-modalities-${crypto.randomUUID()}`,
          "输入模态",
          config.inputModalities.map((item) => ({
            value: item.value,
            label: { text: "文本", image: "图片", pdf: "PDF", audio: "音频", video: "视频" }[item.value],
            selected: draft.input.includes(item.value as "text" | "image"),
            disabled: !item.enabled,
            ...(item.disabledReason ? { disabledReason: item.disabledReason } : {}),
          })),
          interactionController.signal,
        )
        if (selected)
          draft.input = selected.filter((item): item is "text" | "image" => item === "text" || item === "image")
      } else if (action === "output") {
        await selectMultiple(
          overlays,
          `model-output-modalities-${crypto.randomUUID()}`,
          "输出模态（当前仅用于展示扩展边界）",
          config.outputModalities.map((item) => ({
            value: item.value,
            label: { text: "文本", image: "图片", pdf: "PDF", audio: "音频", video: "视频" }[item.value],
            selected: false,
            disabled: !item.enabled,
            ...(item.disabledReason ? { disabledReason: item.disabledReason } : {}),
          })),
          interactionController.signal,
        )
      } else if (action === "reasoning") {
        const thinking = await editThinkingConfiguration(overlays, draft.thinking, interactionController.signal)
        if (thinking === undefined) delete draft.thinking
        else if (thinking !== null) draft.thinking = thinking
      } else if (action === "cost") draft.cost = (await editCost(draft.cost)) ?? draft.cost
      else return draft
    }
    return undefined
  }

  async function confirmAction(title: string, description: string): Promise<boolean> {
    return (
      (await selectItem(
        overlays,
        `confirm-${crypto.randomUUID()}`,
        [
          { name: "确认", description, value: true },
          { name: "取消", description: "不做修改", value: false },
        ],
        { title, signal: interactionController.signal },
      )) ?? false
    )
  }

  async function manageProvider(provider: ProviderConfigEntry, selecting = false): Promise<boolean> {
    while (!exiting) {
      await core.dispatch({ type: "load_model_config" })
      const current = core.getSnapshot().modelConfig?.providers.find((item) => item.id === provider.id)
      if (!current) return false
      const currentModel = core.getSnapshot().currentModel
      const protectsProvider = currentModel?.providerId === current.id
      const action = await selectItem<"edit" | "add" | "delete" | "done" | ModelConfigEntry>(
        overlays,
        "provider-manager",
        [
          {
            name: current.editable ? "编辑供应商" : "编辑供应商（只读）",
            description: current.readonlyReason ?? "修改名称、地址和 API",
            value: "edit",
            disabled: !current.editable,
          },
          { name: "新增模型", description: "", value: "add", disabled: !current.editable },
          ...current.models.map((item) => ({
            name: item.editable ? item.name : `${item.name}（只读）`,
            description: `${item.id}${item.readonlyReason ? ` · ${item.readonlyReason}` : ""}`,
            value: item,
          })),
          {
            name: selecting ? "完成并选择模型" : "完成并返回对话",
            description: "重新加载供应商状态",
            value: "done",
          },
          {
            name: protectsProvider ? "删除供应商（当前会话正在使用）" : "删除供应商",
            description: protectsProvider ? "请先切换模型" : `同时删除 ${current.models.length} 个模型`,
            value: "delete",
            disabled: protectsProvider || !current.editable,
          },
        ],
        { title: current.name, signal: interactionController.signal },
      )
      if (!action) return false
      const revision = core.getSnapshot().modelConfig?.revision ?? ""
      if (action === "edit") {
        const edited = await editProvider(current)
        if (edited) await core.dispatch({ type: "save_provider", revision, provider: edited, create: false })
      } else if (action === "add") {
        const edited = await editModel()
        if (edited)
          await core.dispatch({
            type: "save_model",
            revision,
            providerId: current.id,
            model: edited,
            create: true,
          })
      } else if (action === "done") return true
      else if (action === "delete") {
        if (await confirmAction(`删除供应商 ${current.id}`, "此操作不可撤销")) {
          const result = await core.dispatch({ type: "delete_provider", revision, providerId: current.id })
          if (result.ok) return false
        }
      } else await manageModel(current, action)
    }
    return false
  }

  async function manageModel(provider: ProviderConfigEntry, model: ModelConfigEntry): Promise<void> {
    const current = core.getSnapshot().currentModel
    const protectedModel = current?.providerId === provider.id && current.modelId === model.id
    const action = await selectItem<"edit" | "copy" | "delete">(
      overlays,
      "model-manager",
      [
        {
          name: protectedModel ? "编辑模型（当前会话正在使用）" : "编辑模型",
          description: protectedModel ? "请先切换模型" : (model.readonlyReason ?? ""),
          value: "edit",
          disabled: protectedModel || !model.editable,
        },
        { name: "复制为新模型", description: "保留参数并输入新的模型 ID", value: "copy" },
        {
          name: protectedModel ? "删除模型（当前会话正在使用）" : "删除模型",
          description: protectedModel ? "请先切换模型" : "此操作不可撤销",
          value: "delete",
          disabled: protectedModel || !model.editable,
        },
      ],
      { title: `${provider.id}/${model.id}`, signal: interactionController.signal },
    )
    if (!action) return
    const revision = core.getSnapshot().modelConfig?.revision ?? ""
    if (action === "edit") {
      const edited = await editModel(model)
      if (edited)
        await core.dispatch({
          type: "save_model",
          revision,
          providerId: provider.id,
          model: edited,
          create: false,
        })
    } else if (action === "copy") {
      const copied = await editModel({ ...model, name: `${model.name} 副本` }, true)
      if (copied)
        await core.dispatch({
          type: "save_model",
          revision,
          providerId: provider.id,
          model: copied,
          create: true,
        })
    } else if (await confirmAction(`删除模型 ${model.id}`, "此操作不可撤销")) {
      await core.dispatch({ type: "delete_model", revision, providerId: provider.id, modelId: model.id })
    }
  }

  async function manageModels(
    mode: "standalone" | "select" = "standalone",
    initialProviderId?: string,
  ): Promise<string | undefined> {
    beginInteraction()
    let providerId = initialProviderId
    try {
      while (!exiting) {
        const loaded = await core.dispatch({ type: "load_model_config" })
        if (!loaded.ok) return undefined
        const config = core.getSnapshot().modelConfig
        if (!config) return undefined
        const directProvider = providerId ? config.providers.find((provider) => provider.id === providerId) : undefined
        providerId = undefined
        const selected =
          directProvider ??
          (await selectItem<ProviderConfigEntry | "add">(
            overlays,
            "model-config-providers",
            [
              ...config.providers.map((provider) => ({
                name: provider.editable ? provider.name : `${provider.name}（只读）`,
                description: `${provider.models.length} 个模型${provider.readonlyReason ? ` · ${provider.readonlyReason}` : ""}`,
                value: provider,
              })),
              { name: "新增供应商", description: "配置第三方模型服务", value: "add" as const },
            ],
            { title: "管理供应商和模型", signal: interactionController.signal },
          ))
        if (!selected) return undefined
        if (selected === "add") {
          const edited = await editProvider()
          if (edited) {
            const result = await core.dispatch({
              type: "save_provider",
              revision: config.revision,
              provider: edited,
              create: true,
            })
            if (result.ok) providerId = edited.id
          }
        } else {
          const done = await manageProvider(selected, mode === "select")
          if (done) return mode === "select" ? selected.id : undefined
          if (initialProviderId) return mode === "select" ? selected.id : undefined
        }
      }
      return undefined
    } finally {
      endInteraction()
    }
  }

  async function openSessionSettings(mode: "new" | "existing"): Promise<boolean> {
    let draft: SessionSettingsDraft = { viewId: null }
    if (mode === "new") {
      await dispatchWithError({ type: "load_preferences" }, "读取应用偏好失败")
      const preferred = core.getSnapshot().preferences.newSession
      if (preferred.model) {
        await core.dispatch({ type: "list_models" })
        const available = core
          .getSnapshot()
          .models.find(
            (item) =>
              item.providerId === preferred.model?.providerId &&
              item.modelId === preferred.model.modelId &&
              item.available,
          )
        if (available)
          draft = {
            model: {
              ...available,
              ...(preferred.model.thinkingLevel === undefined ? {} : { thinkingLevel: preferred.model.thinkingLevel }),
            },
            viewId: preferred.viewId,
          }
        else draft = { viewId: preferred.viewId }
      } else draft = { viewId: preferred.viewId }
    }
    if (mode === "existing") {
      const snapshot = core.getSnapshot()
      const current = snapshot.currentModel
      if (!current) return false
      const listed = snapshot.models.find(
        (item) => item.providerId === current.providerId && item.modelId === current.modelId,
      )
      draft = {
        model: {
          ...current,
          name: listed?.name ?? current.modelId,
          available: true,
          ...(listed?.thinkingLevels ? { thinkingLevels: [...listed.thinkingLevels] } : {}),
          ...(listed?.offThinkingLevel ? { offThinkingLevel: listed.offThinkingLevel } : {}),
        },
        viewId: snapshot.currentViewId ?? null,
      }
    }
    while (!exiting) {
      if (!(await dispatchWithError({ type: "list_views" }, "读取视图失败")).ok) return false
      const action = await selectRichItem(
        overlays,
        "session-settings",
        sessionSettingsItems(draft, core.getSnapshot().views, mode),
        {
          title: mode === "new" ? "会话设置 · 新建会话" : "会话设置 · 当前会话",
          signal: interactionController.signal,
        },
      )
      if (!action || action === "cancel") return false
      if (action === "model") {
        const model = await chooseModel()
        if (model) draft = { ...draft, model }
      } else if (action === "view") {
        const viewId = await chooseView()
        if (viewId !== undefined) draft = { ...draft, viewId }
      } else if (action === "manage-models") await manageModels("standalone")
      else if (action === "manage-views") await manageViews()
      else if (action === "apply") {
        if (mode === "new") {
          if (!draft.model) {
            await showError("无法应用设置", "请先选择模型")
            continue
          }
          const result = await dispatchWithError(
            { type: "create_session", model: draft.model, viewId: draft.viewId },
            "创建会话失败",
          )
          return result.ok
        }
        if (!draft.model) continue
        const snapshot = core.getSnapshot()
        const current = snapshot.currentModel
        if (!current || current.providerId !== draft.model.providerId || current.modelId !== draft.model.modelId) {
          if (!(await dispatchWithError({ type: "set_model", model: draft.model }, "切换模型失败")).ok) continue
        }
        if (snapshot.currentViewId !== draft.viewId) {
          if (!(await dispatchWithError({ type: "set_view", viewId: draft.viewId }, "切换视图失败")).ok) continue
        }
        return true
      }
    }
    return false
  }

  async function createSession() {
    await openSessionSettings("new")
  }

  function userTurnOptions() {
    return core
      .getSnapshot()
      .transcript.filter((entry) => entry.type === "input")
      .map((entry, index) => {
        const text = entry.items
          .filter((item) => item.source === "user")
          .flatMap((item) => item.parts)
          .filter((part) => part.kind === "text")
          .map((part) => part.text.trim())
          .find(Boolean)
        return {
          name: text || `第 ${index + 1} 轮`,
          description: `回到第 ${index + 1} 轮之前`,
          value: { turnId: entry.turnId, text: text ?? "" },
        }
      })
  }

  async function changeConversation(action: "rewind" | "fork"): Promise<void> {
    const selected = await selectItem(overlays, `${action}-turn`, userTurnOptions(), {
      title: action === "rewind" ? "选择回退位置" : "选择分支位置",
      signal: interactionController.signal,
    })
    if (!selected) return
    if (action === "rewind") {
      const confirmed = await selectItem(
        overlays,
        "rewind-confirm",
        [
          { name: "确认回退", description: "仅删除对话，不会撤销文件修改和已执行命令", value: true },
          { name: "取消", description: "保留当前对话", value: false },
        ],
        { title: "确认回退对话", signal: interactionController.signal },
      )
      if (!confirmed) return
    }
    const command =
      action === "rewind"
        ? ({ type: "rewind", turnId: selected.turnId } as const)
        : ({ type: "fork_session", turnId: selected.turnId } as const)
    const result = await dispatchWithError(command, action === "rewind" ? "回退对话失败" : "创建会话分支失败")
    if (result.ok) editor.setInputText(selected.text)
  }

  async function renameCurrentSession(): Promise<void> {
    const snapshot = core.getSnapshot()
    if (!snapshot.currentSessionId) return
    const handle = overlays.open<string>({
      id: "rename-current-session",
      title: "重命名当前会话",
      description: "可留空以清除名称",
      actions: [],
      contentHeight: 1,
      signal: interactionController.signal,
    })
    const name = await editInline(overlays, handle, {
      id: "rename-current-session-input",
      label: "会话名称  ",
      initialValue: snapshot.currentSessionName ?? "",
    })
    handle.close(name)
    if (name === undefined) return
    await dispatchWithError(
      { type: "rename_session", sessionId: snapshot.currentSessionId, name },
      "重命名会话失败",
    )
  }

  const sessionSegments = (session: ReturnType<typeof core.getSnapshot>["sessions"][number]) => ({
    segments: [
      ...(session.name ? [{ text: session.name, color: systemColors.header, bold: true }, { text: "  " }] : []),
      { text: session.sessionId, color: systemColors.shortcuts, italic: true, dim: true },
    ],
    details: [
      { text: session.sessionId === core.getSnapshot().currentSessionId ? "● 当前会话 · " : "" },
      { text: `${session.updatedAt} · ${session.preview}`, color: systemColors.shortcuts, dim: true },
    ],
  })

  async function manageSession(sessionId: string): Promise<void> {
    const session = core.getSnapshot().sessions.find((item) => item.sessionId === sessionId)
    if (!session) return
    const action = await selectEditableItem(
      overlays,
      "session-action",
      () => [
        { name: "打开会话", description: "切换到该会话", value: "open" as const },
        {
          name: `会话名称  ${session.name || "当前未命名"}`,
          description: "在当前选项内重命名；可留空",
          value: "renamed" as const,
          edit: {
            label: "会话名称  ",
            value: session.name,
            save: async (name: string) => {
              const result = await dispatchWithError({ type: "rename_session", sessionId, name }, "重命名会话失败")
              if (result.ok) session.name = name
            },
          },
        },
      ],
      { title: `管理会话 · ${session.name || session.sessionId}`, signal: interactionController.signal },
    )
    if (action === "open") await dispatchWithError({ type: "open_session", sessionId }, "打开会话失败")
  }

  async function manageSessions(): Promise<void> {
    while (!exiting) {
      if (!(await dispatchWithError({ type: "list_sessions" }, "读取会话失败")).ok) return
      const sessions = core.getSnapshot().sessions
      const selected = await selectRichItem(
        overlays,
        "sessions-manager",
        sessions.map((session) => ({ ...sessionSegments(session), value: session.sessionId })),
        { title: "管理会话（选择后进入操作菜单）", signal: interactionController.signal },
      )
      if (!selected) return
      await manageSession(selected)
    }
  }

  async function chooseSession() {
    beginInteraction()
    try {
      const listed = await dispatchWithError({ type: "list_sessions" }, "读取会话失败")
      if (!listed.ok) return
      const sessions = core.getSnapshot().sessions
      if (sessions.length === 0) return createSession()
      const selected = await selectRichItem(
        overlays,
        "session-selector",
        [
          {
            segments: [{ text: "新建会话", color: systemColors.header, bold: true }],
            details: [{ text: "使用所选模型开始空白会话", dim: true }],
            value: "__new__",
          },
          {
            segments: [{ text: "管理会话" }],
            details: [{ text: "打开或重命名已有会话", dim: true }],
            value: "__manage__",
          },
          ...sessions.map((session) => ({ ...sessionSegments(session), value: session.sessionId })),
        ],
        { title: "选择会话", signal: interactionController.signal },
      )
      if (selected === "__new__") await createSession()
      else if (selected === "__manage__") await manageSessions()
      else if (selected) await dispatchWithError({ type: "open_session", sessionId: selected }, "打开会话失败")
    } finally {
      endInteraction()
    }
  }

  try {
    while (!exiting && !core.getSnapshot().currentSessionId) {
      await chooseSession()
      if (!core.getSnapshot().currentSessionId) await Bun.sleep(50)
    }
    while (!exiting) {
      await Bun.sleep(50)
    }
  } finally {
    unsubscribe()
    try {
      await actions.flush()
      await core.dispose()
    } finally {
      overlays.dispose()
      editor.destroy()
      view.destroy()
      if (!options.testing) destroyRenderer(renderer)
    }
  }
}
