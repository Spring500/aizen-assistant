import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { preferenceSettingsItems } from "../../apps/tui/preference-settings.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const model = {
  providerId: "anthropic",
  modelId: "claude-haiku",
  api: "anthropic-messages",
  name: "Claude Haiku",
  available: true,
}

const providerNames = new Map([["anthropic", "Anthropic"]])

test("应用偏好展示会话命名模型和关闭状态", () => {
  const enabled = preferenceSettingsItems(
    { providerId: model.providerId, modelId: model.modelId },
    undefined,
    [model],
    providerNames,
  )
  expect(enabled[0]?.segments.map((segment) => segment.text).join("")).toBe(
    "会话自动命名  [ Anthropic · Claude Haiku ]",
  )
  expect(enabled[0]?.allowEmpty).toBe(true)
  const disabled = preferenceSettingsItems(undefined, undefined, [model], providerNames)
  expect(disabled[0]?.segments.map((segment) => segment.text).join("")).toBe("会话自动命名  [ 关闭 ]")
})

test("应用偏好展示工具审核模型与未配置状态", () => {
  const items = preferenceSettingsItems(
    undefined,
    { providerId: model.providerId, modelId: model.modelId },
    [model],
    providerNames,
  )
  expect(items[1]?.segments.map((segment) => segment.text).join("")).toBe("工具审核模型  [ Anthropic · Claude Haiku ]")
  expect(items[1]?.allowEmpty).toBe(true)
  const disabled = preferenceSettingsItems(undefined, undefined, [model], providerNames)
  expect(disabled[1]?.segments.map((segment) => segment.text).join("")).toBe("工具审核模型  [ 未配置 ]")
})
