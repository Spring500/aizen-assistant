import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { viewSettingItem } from "../../apps/tui/view-setting-item.ts"
import type { ViewOption } from "../../packages/core/view-store.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const view: ViewOption = {
  id: "otter-builds-bridge",
  name: "代码审查",
  path: "views/otter-builds-bridge",
  directory: "E:/data/views/otter-builds-bridge",
  valid: true,
  entryId: "otter-builds-bridge",
  state: "healthy",
  issues: [],
  capabilities: { canOpen: true, canWrite: true, canForceOpen: false, canRecover: false },
}

test("视图设置行只显示视图名", () => {
  const item = viewSettingItem({
    viewId: view.id,
    views: [view],
    label: "当前视图",
    placeholder: "无视图",
    value: "view",
  })
  expect(item.segments.map((segment) => segment.text).join("")).toBe("当前视图  [ 代码审查 ]")
})

test("无视图与失效视图都回退占位文案", () => {
  const empty = viewSettingItem({
    viewId: null,
    views: [view],
    label: "当前视图",
    placeholder: "无视图",
    value: "view",
  })
  const missing = viewSettingItem({
    viewId: "missing",
    views: [view],
    label: "当前视图",
    placeholder: "无视图",
    value: "view",
  })
  expect(empty.segments.map((segment) => segment.text).join("")).toBe("当前视图  [ 无视图 ]")
  expect(missing.segments.map((segment) => segment.text).join("")).toBe("当前视图  [ 无视图 ]")
})
