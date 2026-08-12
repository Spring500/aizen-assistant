const definitions = {
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
  "session.read_failed": {
    label: "读取失败",
  },
  "session.in_use": {
    label: "使用中",
  },
} as const

export type SessionIssueCode = keyof typeof definitions

export type SessionIssue<Code extends SessionIssueCode = SessionIssueCode> = {
  code: Code
  label: (typeof definitions)[Code]["label"]
  message: string
}

const codes = new Set<SessionIssueCode>(Object.keys(definitions) as SessionIssueCode[])

/** 会话问题定义同时用于业务内创建和磁盘缓存边界的运行时校验。 */
export const sessionIssues = {
  definitions,
  has(code: string): code is SessionIssueCode {
    return codes.has(code as SessionIssueCode)
  },
  create<Code extends SessionIssueCode>(code: Code, message: string): SessionIssue<Code> {
    return { code, label: definitions[code].label, message }
  },
}
