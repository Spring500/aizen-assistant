import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { defaultAppPreferences } from "../../packages/core/app-preferences-store.ts"
import type { CoreSnapshot } from "../../packages/core/types.ts"
import { statusBarView, type StatusBarViewModel } from "../../packages/tui-kit/status-bar.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

function snapshot(overrides: Partial<CoreSnapshot> = {}): CoreSnapshot {
  return {
    cwd: "E:\\project",
    status: "idle",
    sessions: [],
    models: [],
    preferences: structuredClone(defaultAppPreferences),
    views: [],
    authProviders: [],
    transcript: [],
    transcriptRevision: 0,
    historyTurns: [],
    activeTools: [],
    streamingText: "",
    streamingThinking: "",
    ...overrides,
  }
}

function sessionText(view: StatusBarViewModel): string {
  return typeof view.session === "string" ? view.session : view.session.chunks.map((chunk) => chunk.text).join("")
}

const model = { providerId: "anthropic", modelId: "claude-haiku", api: "anthropic-messages", thinkingLevel: "快速" }

test("状态栏未传模型显示文本时回退 providerId/modelId 形式", () => {
  const view = statusBarView(snapshot({ currentModel: model }))
  expect(sessionText(view)).toContain("模型：anthropic/claude-haiku")
})

test("状态栏使用外部模型显示文本（含思考等级名）", () => {
  const view = statusBarView(snapshot({ currentModel: model }), "Anthropic · Claude Haiku · 快速")
  expect(sessionText(view)).toContain("模型：Anthropic · Claude Haiku · 快速")
})

test("状态栏无模型时显示未选择模型", () => {
  const view = statusBarView(snapshot(), "未选择模型")
  expect(sessionText(view)).toContain("模型：未选择模型")
})
