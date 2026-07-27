import { expect, test } from "bun:test"
import type { ModelOption } from "../../packages/core/pi-port.ts"
import { selectableModelProviders } from "../../packages/tui-kit/model-selection.ts"

const base = {
  api: "openai-completions",
  thinkingLevel: "off",
  contextWindow: 128000,
  name: "模型",
} as const

test("模型选择只包含已认证供应商的可用模型并按供应商分组", () => {
  const models: ModelOption[] = [
    { ...base, providerId: "configured", modelId: "z", name: "Z", available: true },
    { ...base, providerId: "configured", modelId: "a", name: "A", available: true },
    { ...base, providerId: "unconfigured", modelId: "hidden", name: "隐藏", available: false },
  ]
  const result = selectableModelProviders(models, [
    { id: "configured", name: "已认证供应商", configured: true, supportsApiKey: true },
    { id: "unconfigured", name: "未认证供应商", configured: false, supportsApiKey: true },
  ])
  expect(
    result.map((provider) => ({
      id: provider.id,
      name: provider.name,
      modelIds: provider.models.map((model) => model.modelId),
    })),
  ).toEqual([
    {
      id: "configured",
      name: "已认证供应商",
      modelIds: ["a", "z"],
    },
  ])
})
