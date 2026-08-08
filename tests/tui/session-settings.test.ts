import { expect } from "bun:test"
import { modelWithPreferredThinkingLevel, sessionSettingsItems } from "../../apps/tui/session-settings.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const model = {
  providerId: "anthropic",
  modelId: "opus-4-8",
  api: "anthropic-messages",
  thinkingLevel: "off",
  name: "Claude Code Opus 4.8",
  available: true,
}

test("会话设置使用紧凑单行显示模型与视图", () => {
  const items = sessionSettingsItems(
    { model, viewId: "otter-builds-bridge" },
    [
      {
        id: "otter-builds-bridge",
        name: "代码审查",
        path: "views/otter-builds-bridge",
        directory: "E:/data/views/otter-builds-bridge",
        valid: true,
      },
    ],
    "new",
  )
  expect(items[0]?.segments.map((item) => item.text).join("")).toBe("当前模型  [ anthropic · Claude Code Opus 4.8 ]")
  expect(items[1]?.segments.map((item) => item.text).join("")).toBe("当前视图  [ otter-builds-bridge · 代码审查 ]")
  expect(
    items
      .find((item) => item.value === "permission-preset")
      ?.segments.map((item) => item.text)
      .join(""),
  ).toBe("权限预设  [ edit（编辑） ]")
  expect(
    items
      .find((item) => item.value === "permission-review-mode")
      ?.segments.map((item) => item.text)
      .join(""),
  ).toBe("审核方式  [ 完全人工 ]")
  expect(items.find((item) => item.value === "apply")?.segments[0]?.text).toBe("应用并开始对话")
})

test("新建会话偏好中的旧思考档位失效时使用模型当前默认值", () => {
  const available = { ...model, thinkingLevel: "标准", thinkingLevels: ["快速", "标准", "深入"] }
  expect(modelWithPreferredThinkingLevel(available, { ...model, thinkingLevel: "旧档位" }).thinkingLevel).toBe("标准")
  expect(modelWithPreferredThinkingLevel(available, { ...model, thinkingLevel: "深入" }).thinkingLevel).toBe("深入")
})
