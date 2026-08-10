import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import type { ProviderConfigEntry } from "../../packages/core/model-config-store.ts"
import type { AuthProviderOption, ModelOption } from "../../packages/core/pi-port.ts"
import {
  modelProviderChoices,
  providerDisplayNames,
  unconfiguredAuthProviders,
} from "../../packages/tui-kit/model-selection.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const base = {
  api: "openai-completions",
  thinkingLevel: "off",
  contextWindow: 128000,
  name: "模型",
} as const

const authProviders: AuthProviderOption[] = [
  { id: "configured", name: "已认证内置供应商", configured: true, supportsApiKey: true },
  { id: "custom", name: "自定义供应商", configured: false, supportsApiKey: true },
  { id: "hidden", name: "未认证内置供应商", configured: false, supportsApiKey: true },
]

const customProvider: ProviderConfigEntry = {
  id: "custom",
  name: "公司网关",
  baseUrl: "https://example.com/v1",
  api: "openai-completions",
  authHeader: true,
  editable: true,
  models: [],
}

test("供应商选择显示自定义供应商和有可用模型的内置供应商", () => {
  const models: ModelOption[] = [
    { ...base, providerId: "configured", modelId: "z", name: "Z", available: true },
    { ...base, providerId: "configured", modelId: "a", name: "A", available: true },
    { ...base, providerId: "hidden", modelId: "hidden", name: "隐藏", available: false },
  ]
  const result = modelProviderChoices(models, authProviders, [customProvider])
  expect(
    result.map((provider) => ({
      id: provider.id,
      configured: provider.configured,
      modelIds: provider.models.map((model) => model.modelId),
    })),
  ).toEqual([
    { id: "custom", configured: false, modelIds: [] },
    { id: "configured", configured: true, modelIds: ["a", "z"] },
  ])
})

test("认证其它供应商只显示未认证项", () => {
  expect(unconfiguredAuthProviders(authProviders).map((provider) => provider.id)).toEqual(["hidden", "custom"])
})

test("供应商显示名映射遵循自定义 > pi > 认证优先级", () => {
  const piProviders = [
    {
      id: "custom",
      name: "pi 里的 custom",
      enabled: true,
      configured: true,
      authTypes: ["api_key"],
      modelCount: 0,
      canRefresh: false,
    },
    {
      id: "pi-only",
      name: "pi 供应商",
      enabled: true,
      configured: true,
      authTypes: ["api_key"],
      modelCount: 1,
      canRefresh: false,
    },
    {
      id: "disabled",
      name: "停用供应商",
      enabled: false,
      configured: true,
      authTypes: ["api_key"],
      modelCount: 1,
      canRefresh: false,
    },
  ]
  const names = providerDisplayNames(authProviders, [customProvider], piProviders)
  expect(names.get("custom")).toBe("公司网关") // 自定义名优先于 pi 与认证
  expect(names.get("configured")).toBe("已认证内置供应商") // 认证名兜底
  expect(names.get("pi-only")).toBe("pi 供应商") // 已启用的 pi 供应商生效
  expect(names.get("disabled")).toBeUndefined() // 停用的 pi 供应商不参与
  expect(names.get("hidden")).toBe("未认证内置供应商")
})
