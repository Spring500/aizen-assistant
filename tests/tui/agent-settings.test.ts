import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { agentSettingsItems } from "../../apps/tui/agent-settings.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const model = {
  providerId: "anthropic",
  modelId: "claude-haiku",
  api: "anthropic-messages",
  name: "Claude Haiku",
  available: true,
}

test("Agent 设置展示会话命名模型和关闭状态", () => {
  const enabled = agentSettingsItems({ providerId: model.providerId, modelId: model.modelId }, [model])
  expect(enabled[0]?.segments.map((segment) => segment.text).join("")).toBe("会话自动命名  [ Claude Haiku ]")
  const disabled = agentSettingsItems(undefined, [model])
  expect(disabled[0]?.segments.map((segment) => segment.text).join("")).toBe("会话自动命名  [ 关闭 ]")
})
