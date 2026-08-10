import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { modelSettingItem } from "../../apps/tui/model-setting-item.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const model = {
  providerId: "anthropic",
  modelId: "claude-haiku",
  api: "anthropic-messages",
  name: "Claude Haiku",
  available: true,
}

test("模型设置行显示 [ 供应商名 · 模型名 ]", () => {
  const item = modelSettingItem({
    model: { providerId: model.providerId, modelId: model.modelId },
    models: [model],
    providerNames: new Map([["anthropic", "Anthropic"]]),
    label: "会话自动命名",
    placeholder: "关闭",
    allowEmpty: true,
    value: "session-naming",
  })
  expect(item.segments.map((segment) => segment.text).join("")).toBe("会话自动命名  [ Anthropic · Claude Haiku ]")
  expect(item.allowEmpty).toBe(true)
})

test("模型引用自带名称时优先使用，不依赖模型列表", () => {
  const item = modelSettingItem({
    model: { providerId: "anthropic", modelId: "opus-4-8", name: "Opus 4.8" },
    label: "当前模型",
    placeholder: "未选择模型",
    allowEmpty: false,
    value: "model",
  })
  expect(item.segments.map((segment) => segment.text).join("")).toBe("当前模型  [ anthropic · Opus 4.8 ]")
})

test("未选择模型时显示占位文案", () => {
  const empty = modelSettingItem({
    label: "会话自动命名",
    placeholder: "关闭",
    allowEmpty: true,
    value: "session-naming",
  })
  expect(empty.segments.map((segment) => segment.text).join("")).toBe("会话自动命名  [ 关闭 ]")
  expect(empty.allowEmpty).toBe(true)
})
