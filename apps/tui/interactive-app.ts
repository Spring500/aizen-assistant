import { join } from "node:path"
import { AizenCore } from "../../packages/core/aizen-core.ts"
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
import { PiSessionRuntime } from "../../packages/pi-adapter/session-runtime.ts"
import { createChatView } from "../../packages/tui-kit/chat-view.ts"
import { createChatEditor } from "../../packages/tui-kit/editor.ts"
import { statusBarView } from "../../packages/tui-kit/status-bar.ts"

import { selectMultiple } from "../../packages/tui-kit/multi-select.ts"
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
      else if (value === "/models") runAction(manageModels)
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
        const models = core.getSnapshot().models
        const selected = await selectItem<(typeof models)[number] | "__authenticate__" | "__manage__">(
          renderer,
          "model-selector",
          [
            ...models.map((model) => ({
              name: model.available ? model.name : `${model.name}（不可用）`,
              description: model.available
                ? `${model.providerId}/${model.modelId}`
                : `${model.providerId}/${model.modelId} · 请先认证供应商`,
              value: model,
              disabled: !model.available,
            })),
            {
              name: "管理供应商和模型",
              description: "新增、编辑或删除 models.json 配置",
              value: "__manage__" as const,
            },
            {
              name: "认证其它服务商",
              description: "为内置或 models.json 中的服务商保存认证信息",
              value: "__authenticate__" as const,
            },
          ],
          { title: "选择模型", signal: interactionController.signal },
        )
        if (selected === "__manage__") {
          await manageModels()
          continue
        }
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

  async function ask(label: string, initialValue = "") {
    return promptLine(renderer, `model-field-${crypto.randomUUID()}`, `${label}：`, {
      initialValue,
      signal: interactionController.signal,
    })
  }

  async function askRequired(label: string, initialValue = ""): Promise<string | undefined> {
    const value = await ask(label, initialValue)
    return value.trim() ? value.trim() : undefined
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
      renderer,
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
        renderer,
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

  async function editModel(existing?: ModelConfigEntry, copy = false): Promise<EditableModelConfig | undefined> {
    const config = core.getSnapshot().modelConfig
    if (!config) return undefined
    const draft: EditableModelConfig = {
      id: copy ? "" : (existing?.id ?? ""),
      name: existing?.name ?? "",
      ...(existing?.api ? { api: existing.api } : {}),
      reasoning: existing?.reasoning ?? false,
      input: existing ? [...existing.input] : ["text"],
      contextWindow: existing?.contextWindow ?? 128000,
      maxTokens: existing?.maxTokens ?? 16384,
      cost: { ...(existing?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) },
    }
    while (!exiting) {
      const action = await selectItem<
        "id" | "name" | "api" | "input" | "output" | "reasoning" | "context" | "max" | "cost" | "save"
      >(
        renderer,
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
          { name: `推理能力         ${draft.reasoning ? "支持" : "不支持"}`, description: "", value: "reasoning" },
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
          renderer,
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
          renderer,
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
      } else if (action === "reasoning") draft.reasoning = !draft.reasoning
      else if (action === "context")
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
        renderer,
        `confirm-${crypto.randomUUID()}`,
        [
          { name: "确认", description, value: true },
          { name: "取消", description: "不做修改", value: false },
        ],
        { title, signal: interactionController.signal },
      )) ?? false
    )
  }

  async function manageProvider(provider: ProviderConfigEntry): Promise<void> {
    while (!exiting) {
      await core.dispatch({ type: "load_model_config" })
      const current = core.getSnapshot().modelConfig?.providers.find((item) => item.id === provider.id)
      if (!current) return
      const currentModel = core.getSnapshot().currentModel
      const protectsProvider = currentModel?.providerId === current.id
      const action = await selectItem<"edit" | "add" | "delete" | ModelConfigEntry>(
        renderer,
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
            name: protectsProvider ? "删除供应商（当前会话正在使用）" : "删除供应商",
            description: protectsProvider ? "请先切换模型" : `同时删除 ${current.models.length} 个模型`,
            value: "delete",
            disabled: protectsProvider || !current.editable,
          },
        ],
        { title: current.name, signal: interactionController.signal },
      )
      if (!action) return
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
      } else if (action === "delete") {
        if (await confirmAction(`删除供应商 ${current.id}`, "此操作不可撤销")) {
          const result = await core.dispatch({ type: "delete_provider", revision, providerId: current.id })
          if (result.ok) return
        }
      } else await manageModel(current, action)
    }
  }

  async function manageModel(provider: ProviderConfigEntry, model: ModelConfigEntry): Promise<void> {
    const current = core.getSnapshot().currentModel
    const protectedModel = current?.providerId === provider.id && current.modelId === model.id
    const action = await selectItem<"edit" | "copy" | "delete">(
      renderer,
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

  async function manageModels() {
    beginInteraction()
    try {
      while (!exiting) {
        const loaded = await core.dispatch({ type: "load_model_config" })
        if (!loaded.ok) return
        const config = core.getSnapshot().modelConfig
        if (!config) return
        const selected = await selectItem<ProviderConfigEntry | "add">(
          renderer,
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
        )
        if (!selected) return
        if (selected === "add") {
          const edited = await editProvider()
          if (edited)
            await core.dispatch({
              type: "save_provider",
              revision: config.revision,
              provider: edited,
              create: true,
            })
        } else await manageProvider(selected)
      }
    } finally {
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
