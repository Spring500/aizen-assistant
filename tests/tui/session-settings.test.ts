import { expect, test } from "bun:test"
import { sessionSettingsItems } from "../../apps/tui/session-settings.ts"

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
  expect(items.find((item) => item.value === "apply")?.segments[0]?.text).toBe("应用并开始对话")
})
