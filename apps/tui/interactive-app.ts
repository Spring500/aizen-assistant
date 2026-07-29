import { join } from "node:path"
import { type CliRenderer, SelectRenderable } from "@opentui/core"
import { AizenCore } from "../../packages/core/aizen-core.ts"
import { AppPreferencesStore } from "../../packages/core/app-preferences-store.ts"
import type {
  ConfigurableApi,
  EditableModelConfig,
  EditableProviderConfig,
  ModelConfigEntry,
  ModelCostConfig,
  ModelThinkingConfig,
  ProviderConfigEntry,
} from "../../packages/core/model-config-store.ts"
import { ModelConfigStore } from "../../packages/core/model-config-store.ts"
import { projectDirectoryName } from "../../packages/core/paths.ts"
import { SessionStore } from "../../packages/core/session-store.ts"
import type { CorePort } from "../../packages/core/types.ts"
import { ViewStore } from "../../packages/core/view-store.ts"
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { createChatView } from "../../packages/tui-kit/chat-view.ts"
import { createChatEditor } from "../../packages/tui-kit/editor.ts"
import { modelProviderChoices, unconfiguredAuthProviders } from "../../packages/tui-kit/model-selection.ts"
import { selectMultiple } from "../../packages/tui-kit/multi-select.ts"
import { OverlayManager } from "../../packages/tui-kit/overlay-manager.ts"
import { promptLine } from "../../packages/tui-kit/prompt.ts"
import { createAizenRenderer, destroyRenderer } from "../../packages/tui-kit/renderer.ts"
import { selectRichItem } from "../../packages/tui-kit/rich-selector.ts"
import { selectItem } from "../../packages/tui-kit/selector.ts"
import { statusBarView } from "../../packages/tui-kit/status-bar.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"

import { ActionQueue, dispatchOrPresent } from "./action-runner.ts"
import { openDirectory, openExternalEditor } from "./external-open.ts"
import { type SessionSettingsDraft, sessionSettingsItems } from "./session-settings.ts"
import { viewSelectionItems } from "./view-flow.ts"

const createViewValue = ":create-view"
const manageViewsValue = ":manage-views"

export type InteractiveAppOptions = {
  cwd: string
  dataDirectory: string
  testing?: { renderer: CliRenderer; core: CorePort }
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
    await selectItem(overlays, `error-${crypto.randomUUID()}`, [{ name: "返回", description: error, value: true }], {
      title,
      signal: interactionController.signal,
    })
  }
  const actions = new ActionQueue(showError)
  const runAction = (operation: () => Promise<unknown>) => actions.run(operation)
  const dispatchWithError = (command: Parameters<typeof core.dispatch>[0], title: string) =>
    dispatchOrPresent(core, command, title, showError)
  const editor = createChatEditor(
    renderer,
    {
      onSubmit: (value) => {
        if (value === "/quit") quit()
        else if (value === "/new") runAction(createSession)
        else if (value === "/sessions") runAction(chooseSession)
        else if (value === "/views") runAction(manageViews)
        else if (value === "/view" || value === "/model") runAction(() => openSessionSettings("existing"))
        else if (value === "/fold") runAction(chooseFold)
        else if (value === "/models") runAction(manageModels)
        else runAction(() => dispatchWithError({ type: "send_prompt", text: value }, "发送消息失败"))
      },
      onAbort: () => void core.dispatch({ type: "abort" }),
      onQuit: quit,
    },
    overlays,
  )
  editor.setInputVisible(false)

  const updateStatusBar = () => {
    const snapshot = core.getSnapshot()
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
      void promptLine(overlays, `auth-${event.promptId}`, label, {
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

  async function createView(): Promise<void> {
    const name = await promptLine(overlays, "view-name", "视图名称：", { signal: interactionController.signal })
    if (!name) return
    const result = await dispatchWithError({ type: "create_view", name }, "创建视图失败")
    if (!result.ok) return
    const created = core.getSnapshot().views.find((item) => item.name === name)
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
        const selected = await selectItem<string | null>(
          overlays,
          "view-selector",
          [
            ...viewSelectionItems(core.getSnapshot().views),
            { name: "新建视图", description: "创建视图模板并立即使用", value: createViewValue },
            { name: "管理视图", description: "编辑、移除或删除视图", value: manageViewsValue },
          ],
          { title: "选择视图", signal: interactionController.signal },
        )
        if (selected === createViewValue) {
          await createView()
          continue
        }
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
        const selected = await selectItem(
          overlays,
          "views-manager",
          [
            { name: "刷新", description: "重新读取 views.json 和目录状态", value: "__refresh__" },
            { name: "创建视图模板", description: "创建 AGENTS.md 和 skills 目录", value: "__create__" },
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
        if (selected === "__create__") {
          await createView()
          continue
        }
        await manageView(selected)
      }
    } finally {
      endInteraction()
    }
  }

  async function manageView(viewId: string) {
    const viewItem = core.getSnapshot().views.find((item) => item.id === viewId)
    if (!viewItem) return
    const action = await selectItem(
      overlays,
      "view-action",
      [
        { name: "编辑名称", description: viewItem.name, value: "name" },
        { name: "编辑目录路径", description: viewItem.path, value: "path" },
        { name: "编辑 SYSTEM.md", description: "不存在时自动创建", value: "system" },
        { name: "编辑 AGENTS.md", description: "不存在时自动创建", value: "agents" },
        { name: "打开 Skills 目录", description: viewItem.directory, value: "skills" },
        { name: "移除注册", description: "保留视图目录和文件", value: "remove" },
        { name: "删除视图目录", description: "同时删除注册和目录，需要再次确认", value: "delete" },
      ],
      { title: `管理视图 · ${viewItem.name}`, signal: interactionController.signal },
    )
    if (action === "name") {
      const name = await promptLine(overlays, "view-edit-name", "新名称：", {
        initialValue: viewItem.name,
        signal: interactionController.signal,
      })
      if (name) await dispatchWithError({ type: "update_view", viewId, name }, "更新视图失败")
    } else if (action === "path") {
      const path = await promptLine(overlays, "view-edit-path", "新路径：", {
        initialValue: viewItem.path,
        signal: interactionController.signal,
      })
      if (path) await dispatchWithError({ type: "update_view", viewId, path }, "更新视图失败")
    } else if (action === "system" || action === "agents") {
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
        const selected = await selectItem<(typeof fields)[number]["key"] | "reset" | "apply">(
          overlays,
          "fold-selector",
          [
            ...fields.map((field) => ({
              name: `${field.name.padEnd(6, "　")} ${draft[field.key] === 0 ? "全部展开" : `最近 ${draft[field.key]} 轮`}`,
              description: field.key === "toolDetailTurns" ? "不能超过工具组；0 表示全部展开" : "0 表示全部展开",
              value: field.key,
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
        const value = await promptLine(overlays, `fold-${selected}`, "展开轮次（0 表示全部）：", {
          initialValue: String(draft[selected]),
          signal: interactionController.signal,
        })
        if (value === undefined || !/^\d+$/.test(value)) continue
        const parsed = Number(value)
        if (!Number.isSafeInteger(parsed)) continue
        draft = { ...draft, [selected]: parsed }
        if (
          selected === "toolGroupTurns" &&
          draft.toolGroupTurns !== 0 &&
          (draft.toolDetailTurns === 0 || draft.toolDetailTurns > draft.toolGroupTurns)
        )
          draft.toolDetailTurns = draft.toolGroupTurns
        if (
          selected === "toolDetailTurns" &&
          (draft.toolDetailTurns === 0
            ? draft.toolGroupTurns !== 0
            : draft.toolGroupTurns !== 0 && draft.toolDetailTurns > draft.toolGroupTurns)
        )
          draft.toolGroupTurns = draft.toolDetailTurns
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
            { title: `选择思考档位 · 最多六个开启档位`, signal: interactionController.signal },
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

  async function ask(label: string, initialValue = "") {
    return promptLine(overlays, `model-field-${crypto.randomUUID()}`, `${label}：`, {
      initialValue,
      signal: interactionController.signal,
    })
  }

  async function askRequired(label: string, initialValue = ""): Promise<string | undefined> {
    const value = await ask(label, initialValue)
    return value?.trim() ? value.trim() : undefined
  }

  async function askNumber(label: string, initialValue: number): Promise<number | undefined> {
    const value = await ask(label, String(initialValue))
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
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
      const action = await selectItem<"id" | "name" | "baseUrl" | "api" | "authHeader" | "save">(
        overlays,
        "provider-editor",
        [
          {
            name: `供应商 ID       ${draft.id ?? "未设置"}`,
            description: existing ? "创建后不可修改" : "小写字母、数字、点、下划线或短横线",
            value: "id",
            disabled: !!existing,
          },
          { name: `显示名称        ${draft.name || "未设置"}`, description: "", value: "name" },
          { name: `Base URL        ${draft.baseUrl || "未设置"}`, description: "", value: "baseUrl" },
          { name: `API             ${draft.api ?? "未设置"}`, description: "", value: "api" },
          {
            name: `Bearer 认证头   ${draft.authHeader ? "是" : "否"}`,
            description: "",
            value: "authHeader",
          },
          { name: "保存", description: "校验并应用配置", value: "save" },
        ],
        { title: existing ? `编辑供应商 ${existing.id}` : "新增供应商", signal: interactionController.signal },
      )
      if (!action) return undefined
      if (action === "id") {
        const value = await askRequired("供应商 ID", draft.id)
        if (value) draft.id = value
      } else if (action === "name") {
        const value = await askRequired("显示名称", draft.name)
        if (value) draft.name = value
      } else if (action === "baseUrl") {
        const value = await askRequired("Base URL", draft.baseUrl)
        if (value) draft.baseUrl = value
      } else if (action === "api") {
        const selected = await chooseApi("选择供应商 API")
        if (selected !== "cancel" && selected !== undefined) draft.api = selected
      } else if (action === "authHeader") draft.authHeader = !draft.authHeader
      else if (draft.id && draft.name && draft.baseUrl && draft.api && draft.authHeader !== undefined)
        return draft as EditableProviderConfig
    }
    return undefined
  }

  async function editCost(initial: ModelCostConfig): Promise<ModelCostConfig | undefined> {
    const input = await askNumber("输入价格（美元/百万 token）", initial.input)
    if (input === undefined) return undefined
    const output = await askNumber("输出价格（美元/百万 token）", initial.output)
    if (output === undefined) return undefined
    const cacheRead = await askNumber("Cache Read 价格", initial.cacheRead)
    if (cacheRead === undefined) return undefined
    const cacheWrite = await askNumber("Cache Write 价格", initial.cacheWrite)
    if (cacheWrite === undefined) return undefined
    return { input, output, cacheRead, cacheWrite }
  }

  async function editThinkingLevels(initial: string[]): Promise<string[] | undefined> {
    const levels = [...initial]
    return new Promise((resolve) => {
      let editing: { index: number; value: string; adding: boolean; originalLevels: string[] } | undefined
      let settled = false
      const finish = (value: string[] | undefined) => {
        if (settled) return
        settled = true
        handle.close(value)
        resolve(value)
      }
      const handle = overlays.open<string[]>({
        id: "thinking-level-editor",
        title: "开启思考档位",
        help: "↑↓ 选择 | Enter 编辑 | Esc 返回",
        contentHeight: Math.min(18, Math.max(6, (levels.length + 2) * 3 - 2)),
        signal: interactionController.signal,
        onCancel: () => finish(undefined),
      })
      const selector = new SelectRenderable(overlays.renderer, {
        id: "thinking-level-list",
        options: [],
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        showDescription: true,
        textColor: systemColors.secondary,
        descriptionColor: systemColors.shortcuts,
      })
      handle.content.add(selector)
      const render = (selectedIndex = selector.getSelectedIndex()) => {
        selector.options = [
          ...levels.map((level, index) => ({
            name: `${index + 1}. ${editing?.index === index ? `${editing.value}█` : level}`,
            description: editing?.index === index ? "↑/↓ 排序 · Ctrl+X 删除 · Enter 确认 · Esc 取消" : "Enter 原地编辑",
            value: `item:${index}`,
          })),
          {
            name: editing?.adding
              ? `新增档位  ${editing.value}█`
              : `新增档位                              ${levels.length} / 6`,
            description: editing?.adding
              ? "Enter 确认 · Esc 取消"
              : levels.length >= 6
                ? "已达到六个开启档位上限"
                : "Enter 原地输入",
            value: "add",
          },
          { name: "完成", description: `当前 ${levels.length} / 6`, value: "done" },
        ]
        selector.setSelectedIndex(Math.min(selectedIndex, levels.length + 1))
        handle.setContentHeight(Math.min(18, Math.max(6, (levels.length + 2) * 3 - 2)))
      }
      const stopEditing = (cancelled: boolean) => {
        if (cancelled && editing) levels.splice(0, levels.length, ...editing.originalLevels)
        const selectedIndex = editing?.adding ? levels.length : (editing?.index ?? selector.getSelectedIndex())
        editing = undefined
        handle.setHelp("↑↓ 选择 | Enter 编辑 | Esc 返回")
        render(selectedIndex)
      }
      const confirmEditing = () => {
        if (!editing) return
        const value = editing.value.trim()
        if (!value) return
        if (editing.adding) levels.push(value)
        else levels[editing.index] = value
        stopEditing(false)
      }
      handle.setInput({
        keypress: (key) => {
          if (editing) {
            if (key.name === "return") confirmEditing()
            else if (key.name === "escape") stopEditing(true)
            else if (!editing.adding && key.ctrl && key.name === "x") {
              if (levels.length <= 1) {
                handle.setHelp("至少保留一个开启档位 | ↑/↓ 排序 | Enter 确认 | Esc 取消")
                return
              }
              const index = editing.index
              levels.splice(index, 1)
              editing = undefined
              handle.setHelp("↑↓ 选择 | Enter 编辑 | Esc 返回")
              render(Math.min(index, levels.length - 1))
            } else if (!editing.adding && key.name === "up" && editing.index > 0) {
              const index = editing.index
              ;[levels[index - 1], levels[index]] = [levels[index] ?? "", levels[index - 1] ?? ""]
              editing.index--
              render(editing.index)
            } else if (!editing.adding && key.name === "down" && editing.index < levels.length - 1) {
              const index = editing.index
              ;[levels[index], levels[index + 1]] = [levels[index + 1] ?? "", levels[index] ?? ""]
              editing.index++
              render(editing.index)
            } else if (key.name === "backspace") {
              editing.value = Array.from(editing.value).slice(0, -1).join("")
              render()
            } else if (!key.ctrl && !key.meta && key.sequence.length > 0) {
              editing.value += key.sequence
              render()
            }
            return
          }
          const index = selector.getSelectedIndex()
          if (key.name === "escape") finish(levels)
          else if (key.name === "return") {
            if (index < levels.length) {
              editing = { index, value: levels[index] ?? "", adding: false, originalLevels: [...levels] }
              handle.setHelp("输入修改名称 | ↑/↓ 排序 | Ctrl+X 删除 | Enter 确认 | Esc 取消")
              render(index)
            } else if (index === levels.length && levels.length < 6) {
              editing = { index, value: "", adding: true, originalLevels: [...levels] }
              handle.setHelp("输入新增档位名 | Enter 确认 | Esc 取消")
              render(index)
            } else if (index === levels.length + 1) finish(levels)
          } else selector.handleKeyPress?.(key)
        },
        paste: (event) => {
          if (!editing) return
          editing.value += new TextDecoder().decode(event.bytes).replace(/[\r\n]+/g, "")
          render()
        },
      })
      render()
    })
  }

  async function editThinkingConfig(initial?: ModelThinkingConfig): Promise<ModelThinkingConfig | undefined | null> {
    let supported = initial !== undefined
    let allowDisable = initial?.disableThinkingLevel !== undefined
    let disableThinkingLevel = initial?.disableThinkingLevel ?? "off"
    let thinkingLevels = [...(initial?.thinkingLevels ?? ["low", "medium", "high"])]
    let defaultThinkingLevel = initial?.defaultThinkingLevel ?? thinkingLevels[1] ?? thinkingLevels[0] ?? ""
    return new Promise((resolve) => {
      let editingDisable: { value: string } | undefined
      let settled = false
      const finish = (value: ModelThinkingConfig | undefined | null) => {
        if (settled) return
        settled = true
        handle.close(value ?? undefined)
        resolve(value)
      }
      const handle = overlays.open<ModelThinkingConfig>({
        id: "thinking-config-editor",
        title: "编辑思考配置",
        help: "↑↓ 移动 | Enter 选择 | Esc 返回",
        contentHeight: 16,
        signal: interactionController.signal,
        onCancel: () => finish(null),
      })
      const selector = new SelectRenderable(overlays.renderer, {
        id: "thinking-config-list",
        options: [],
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        showDescription: true,
        textColor: systemColors.secondary,
        descriptionColor: systemColors.shortcuts,
      })
      handle.content.add(selector)
      const render = (selectedIndex = selector.getSelectedIndex()) => {
        const summary = [allowDisable ? disableThinkingLevel : undefined, ...thinkingLevels].filter(Boolean).join("、")
        selector.options = [
          { name: `思考能力        ${supported ? "支持" : "不支持"}`, description: "Enter 切换", value: "supported" },
          {
            name: `允许关闭思考    ${supported && allowDisable ? "是" : "否"}`,
            description: supported ? "Enter 切换" : "请先启用思考能力",
            value: "allowDisable",
          },
          {
            name: `关闭档位名      ${editingDisable ? `${editingDisable.value}█` : supported && allowDisable ? disableThinkingLevel : "—"}`,
            description: editingDisable
              ? "Enter 确认 · Esc 取消"
              : supported && allowDisable
                ? "Enter 原地编辑"
                : "未允许关闭思考",
            value: "disable",
          },
          {
            name: `开启思考档位    ${supported ? summary : "—"}       ${thinkingLevels.length} / 6`,
            description: supported ? "Enter 管理；编辑态用 ↑/↓ 排序、Ctrl+X 删除" : "请先启用思考能力",
            value: "levels",
          },
          {
            name: `默认档位        ${supported ? defaultThinkingLevel || "未设置" : "—"}`,
            description: supported ? "从合法档位中选择" : "请先启用思考能力",
            value: "default",
          },
          { name: "保存", description: supported ? "校验并返回模型编辑页" : "清除全部思考配置", value: "save" },
        ]
        selector.setSelectedIndex(selectedIndex)
      }
      const validSelection = (index: number) =>
        index === 0 || index === 5 || (supported && index !== 2) || (supported && allowDisable)
      const stopEditing = (confirm: boolean) => {
        if (confirm && editingDisable?.value.trim()) {
          const previous = disableThinkingLevel
          disableThinkingLevel = editingDisable.value.trim()
          if (defaultThinkingLevel === previous) defaultThinkingLevel = disableThinkingLevel
        }
        editingDisable = undefined
        handle.setHelp("↑↓ 移动 | Enter 选择 | Esc 返回")
        render(2)
      }
      const chooseDefault = async () => {
        const available = [...(allowDisable ? [disableThinkingLevel] : []), ...thinkingLevels]
        const selected = await selectItem<string>(
          overlays,
          `thinking-default-${crypto.randomUUID()}`,
          available.map((level) => ({
            name: level,
            description: level === disableThinkingLevel ? "关闭档位" : "开启档位",
            value: level,
          })),
          { title: "选择默认思考档位", signal: interactionController.signal },
        )
        if (selected) defaultThinkingLevel = selected
        render(4)
      }
      const manageLevels = async () => {
        const edited = await editThinkingLevels(thinkingLevels)
        if (edited) {
          thinkingLevels = edited
          const available = [...(allowDisable ? [disableThinkingLevel] : []), ...thinkingLevels]
          if (!available.includes(defaultThinkingLevel))
            defaultThinkingLevel = thinkingLevels[0] ?? disableThinkingLevel
        }
        render(3)
      }
      handle.setInput({
        keypress: (key) => {
          if (editingDisable) {
            if (key.name === "return") stopEditing(true)
            else if (key.name === "escape") stopEditing(false)
            else if (key.name === "backspace") {
              editingDisable.value = Array.from(editingDisable.value).slice(0, -1).join("")
              render(2)
            } else if (!key.ctrl && !key.meta && key.sequence.length > 0) {
              editingDisable.value += key.sequence
              render(2)
            }
            return
          }
          if (key.name === "escape") finish(null)
          else if (key.name === "return") {
            const index = selector.getSelectedIndex()
            if (!validSelection(index)) return
            if (index === 0) {
              supported = !supported
              if (!supported) {
                allowDisable = false
                disableThinkingLevel = "off"
                thinkingLevels = []
                defaultThinkingLevel = ""
              } else {
                thinkingLevels = ["low", "medium", "high"]
                defaultThinkingLevel = "medium"
              }
              render(index)
            } else if (index === 1) {
              allowDisable = !allowDisable
              if (allowDisable && !disableThinkingLevel) disableThinkingLevel = "off"
              if (!allowDisable && defaultThinkingLevel === disableThinkingLevel)
                defaultThinkingLevel = thinkingLevels[0] ?? ""
              render(index)
            } else if (index === 2) {
              editingDisable = { value: disableThinkingLevel }
              handle.setHelp("输入关闭档位名 | Enter 确认 | Esc 取消")
              render(index)
            } else if (index === 3) void manageLevels()
            else if (index === 4) void chooseDefault()
            else if (!supported) finish(undefined)
            else finish({ ...(allowDisable ? { disableThinkingLevel } : {}), thinkingLevels, defaultThinkingLevel })
          } else selector.handleKeyPress?.(key)
        },
        paste: (event) => {
          if (!editingDisable) return
          editingDisable.value += new TextDecoder().decode(event.bytes).replace(/[\r\n]+/g, "")
          render(2)
        },
      })
      render()
    })
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
      const action = await selectItem<
        "id" | "name" | "api" | "input" | "output" | "reasoning" | "context" | "max" | "cost" | "save"
      >(
        overlays,
        "model-editor",
        [
          {
            name: `模型 ID          ${draft.id || "未设置"}`,
            description: existing && !copy ? "创建后不可修改" : "",
            value: "id",
            disabled: !!existing && !copy,
          },
          { name: `显示名称         ${draft.name || "未设置"}`, description: "", value: "name" },
          { name: `API              ${draft.api ?? "继承供应商"}`, description: "", value: "api" },
          { name: `输入模态         ${draft.input.join("、")}`, description: "多选", value: "input" },
          { name: "输出模态         当前 adapter 不支持配置", description: "查看扩展边界", value: "output" },
          {
            name: `思考档位         ${draft.thinking ? [draft.thinking.disableThinkingLevel, ...draft.thinking.thinkingLevels].filter(Boolean).join("、") : "不支持"}`,
            description: draft.thinking ? "关闭档位独立显示；最多六个开启档位" : "Enter 启用",
            value: "reasoning",
          },
          { name: `上下文窗口       ${draft.contextWindow}`, description: "", value: "context" },
          { name: `最大输出 token   ${draft.maxTokens}`, description: "", value: "max" },
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
      if (action === "id") draft.id = (await askRequired("模型 ID", draft.id)) ?? draft.id
      else if (action === "name") draft.name = (await askRequired("显示名称", draft.name)) ?? draft.name
      else if (action === "api") {
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
        const thinking = await editThinkingConfig(draft.thinking)
        if (thinking === undefined) delete draft.thinking
        else if (thinking !== null) draft.thinking = thinking
      } else if (action === "context")
        draft.contextWindow = (await askNumber("上下文窗口", draft.contextWindow)) ?? draft.contextWindow
      else if (action === "max")
        draft.maxTokens = (await askNumber("最大输出 token", draft.maxTokens)) ?? draft.maxTokens
      else if (action === "cost") draft.cost = (await editCost(draft.cost)) ?? draft.cost
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

  async function renameSession(sessionId: string): Promise<void> {
    const session = core.getSnapshot().sessions.find((item) => item.sessionId === sessionId)
    if (!session) return
    const name = await promptLine(overlays, "session-rename", "会话名称（可留空）：", {
      initialValue: session.name,
      signal: interactionController.signal,
    })
    if (name === undefined) return
    await dispatchWithError({ type: "rename_session", sessionId, name }, "重命名会话失败")
  }

  async function manageSession(sessionId: string): Promise<void> {
    const session = core.getSnapshot().sessions.find((item) => item.sessionId === sessionId)
    if (!session) return
    const action = await selectRichItem(
      overlays,
      "session-action",
      [
        { segments: [{ text: "打开会话" }], value: "open" as const },
        {
          segments: [{ text: "重命名" }],
          details: [{ text: session.name || "当前未命名", dim: true }],
          value: "rename" as const,
        },
      ],
      { title: `管理会话 · ${session.name || session.sessionId}`, signal: interactionController.signal },
    )
    if (action === "open") await dispatchWithError({ type: "open_session", sessionId }, "打开会话失败")
    else if (action === "rename") await renameSession(sessionId)
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
