import { expect } from "bun:test"
import type { ModelOption } from "../../packages/core/pi-port.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { modelDisplayText, modelSettingItem } from "../../apps/tui/model-setting-item.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const model: ModelOption = {
  providerId: "anthropic",
  modelId: "claude-haiku",
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

test("模型引用不带名称时从模型列表查表解析", () => {
  const item = modelSettingItem({
    model: { providerId: "anthropic", modelId: "claude-haiku" },
    models: [model],
    providerNames: new Map([["anthropic", "Anthropic"]]),
    label: "当前模型",
    placeholder: "未选择模型",
    allowEmpty: false,
    value: "model",
  })
  expect(item.segments.map((segment) => segment.text).join("")).toBe("当前模型  [ Anthropic · Claude Haiku ]")
})

test("供应商名缺失时回退 providerId，模型列表缺失时回退 modelId", () => {
  const item = modelSettingItem({
    model: { providerId: "anthropic", modelId: "opus-4-8" },
    label: "当前模型",
    placeholder: "未选择模型",
    allowEmpty: false,
    value: "model",
  })
  expect(item.segments.map((segment) => segment.text).join("")).toBe("当前模型  [ anthropic · opus-4-8 ]")
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

test("模型存在思考等级时追加思考等级名", () => {
  const item = modelSettingItem({
    model: { providerId: "anthropic", modelId: "opus-4-8", thinkingLevel: "快速" },
    providerNames: new Map([["anthropic", "Anthropic"]]),
    models: [{ ...model, modelId: "opus-4-8", name: "Opus 4.8" }],
    label: "当前模型",
    placeholder: "未选择模型",
    allowEmpty: false,
    value: "model",
  })
  expect(item.segments.map((segment) => segment.text).join("")).toBe("当前模型  [ Anthropic · Opus 4.8 · 快速 ]")
})

test("纯文本模型显示与设置行共用解析格式", () => {
  const providerNames = new Map([["anthropic", "Anthropic"]])
  expect(modelDisplayText(undefined, [model], providerNames)).toBe("未选择模型")
  expect(modelDisplayText({ providerId: "anthropic", modelId: "claude-haiku" }, [model], providerNames)).toBe(
    "Anthropic · Claude Haiku",
  )
  expect(
    modelDisplayText(
      { providerId: "anthropic", modelId: "claude-haiku", thinkingLevel: "深入" },
      [model],
      providerNames,
    ),
  ).toBe("Anthropic · Claude Haiku · 深入")
})
