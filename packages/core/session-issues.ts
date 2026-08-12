import { defineIssues } from "./resource-catalog.ts"

export const sessionIssues = defineIssues({
  "session.invalid_json": {
    label: "内容损坏",
  },
  "session.incompatible_record": {
    label: "不兼容",
  },
  "session.record_validation_failed": {
    label: "内容损坏",
  },
  "session.incomplete_tail": {
    label: "未完整写入",
  },
  "session.id_conflict": {
    label: "ID 冲突",
  },
  "session.read_failed": {
    label: "读取失败",
  },
  "session.in_use": {
    label: "使用中",
  },
})

export type SessionIssueCode = keyof typeof sessionIssues.definitions

export type SessionIssue = ReturnType<typeof sessionIssues.create>
