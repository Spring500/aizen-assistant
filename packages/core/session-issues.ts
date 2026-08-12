import { defineIssues } from "./resource-catalog.ts"

export const sessionIssues = defineIssues({
  "session.invalid_json": {
    category: "syntax",
    label: "内容损坏",
  },
  "session.record_validation_failed": {
    category: "integrity",
    label: "不兼容",
  },
  "session.incomplete_tail": {
    category: "incomplete",
    label: "未完整写入",
  },
  "session.id_conflict": {
    category: "conflict",
    label: "ID 冲突",
  },
  "session.read_failed": {
    category: "io",
    label: "读取失败",
  },
  "session.in_use": {
    category: "availability",
    label: "使用中",
  },
})

export type SessionIssueCode = keyof typeof sessionIssues.definitions
