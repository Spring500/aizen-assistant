export const permissionTags = [
  "read-workspace",
  "read-home",
  "read-system",
  "read-sensitive",
  "edit-workspace",
  "edit-home",
  "edit-system",
  "edit-sensitive",
  "network-fetch",
  "network-send",
  "system-change",
  "violation",
] as const

export type PermissionTag = (typeof permissionTags)[number]

export const configurablePermissionKeys = [
  "read-workspace",
  "read-home",
  "read-system",
  "read-sensitive",
  "edit-workspace",
  "edit-home",
  "edit-system",
  "edit-sensitive",
  "network-fetch",
  "network-send",
  "system-change",
  "unknown",
] as const

export type ConfigurablePermissionKey = (typeof configurablePermissionKeys)[number]

export const permissionDispositions = ["allow", "aiReview", "needHumanReview", "deny"] as const
export type PermissionDisposition = (typeof permissionDispositions)[number]

export const permissionReviewModes = ["manual", "aiReview", "aiReviewWithAbstain", "autoApprove", "autoDeny"] as const
export type PermissionReviewMode = (typeof permissionReviewModes)[number]

export const permissionPresetIds = ["plan", "edit", "all-right", "custom"] as const
export type PermissionPresetId = (typeof permissionPresetIds)[number]
export type BuiltinPermissionPresetId = Exclude<PermissionPresetId, "custom">

export type PermissionClaim = {
  tag: PermissionTag
  reason?: string
}

/** 标签到英文可读名的映射，用于审查界面、AI 审核输入与拒绝消息。 */
export const permissionTagNames: Record<PermissionTag, string> = {
  "read-workspace": "Read workspace files",
  "read-home": "Read files in the home directory",
  "read-system": "Read system files",
  "read-sensitive": "Read sensitive files",
  "edit-workspace": "Modify workspace files",
  "edit-home": "Modify files in the home directory",
  "edit-system": "Modify system files",
  "edit-sensitive": "Modify sensitive files",
  "network-fetch": "Fetch data from the network",
  "network-send": "Send data over the network",
  "system-change": "Change system state",
  violation: "Unsafe operation",
}

/** 可配置策略键（含 unknown 伪标签）到英文可读名的映射，用于拒绝消息与摘要。 */
export const permissionKeyNames: Record<ConfigurablePermissionKey, string> = {
  "read-workspace": "Read workspace files",
  "read-home": "Read files in the home directory",
  "read-system": "Read system files",
  "read-sensitive": "Read sensitive files",
  "edit-workspace": "Modify workspace files",
  "edit-home": "Modify files in the home directory",
  "edit-system": "Modify system files",
  "edit-sensitive": "Modify sensitive files",
  "network-fetch": "Fetch data from the network",
  "network-send": "Send data over the network",
  "system-change": "Change system state",
  unknown: "Unclassifiable",
}

/** 将处置档位对应的策略键解析为可读名；violation 与缺失键回退到标签表或原值。 */
export function permissionRuleName(key: ConfigurablePermissionKey | "violation" | undefined): string | undefined {
  if (!key) return undefined
  return permissionKeyNames[key as ConfigurablePermissionKey] ?? permissionTagNames[key as PermissionTag] ?? key
}

export type PermissionClassifyResult = { kind: "claims"; claims: PermissionClaim[] } | { kind: "abstain" }

export type PermissionPolicy = {
  version: 1
  preset: PermissionPresetId
  dispositions: Record<ConfigurablePermissionKey, PermissionDisposition>
}

function policy(preset: BuiltinPermissionPresetId, dispositions: PermissionPolicy["dispositions"]): PermissionPolicy {
  return { version: 1, preset, dispositions }
}

export const builtinPermissionPolicies: Record<BuiltinPermissionPresetId, PermissionPolicy> = {
  plan: policy("plan", {
    "read-workspace": "allow",
    "read-home": "aiReview",
    "read-system": "aiReview",
    "read-sensitive": "needHumanReview",
    "edit-workspace": "deny",
    "edit-home": "deny",
    "edit-system": "deny",
    "edit-sensitive": "deny",
    "network-fetch": "aiReview",
    "network-send": "deny",
    "system-change": "deny",
    unknown: "needHumanReview",
  }),
  edit: policy("edit", {
    "read-workspace": "allow",
    "read-home": "allow",
    "read-system": "allow",
    "read-sensitive": "needHumanReview",
    "edit-workspace": "allow",
    "edit-home": "aiReview",
    "edit-system": "needHumanReview",
    "edit-sensitive": "needHumanReview",
    "network-fetch": "allow",
    "network-send": "aiReview",
    "system-change": "needHumanReview",
    unknown: "needHumanReview",
  }),
  "all-right": policy("all-right", {
    "read-workspace": "allow",
    "read-home": "allow",
    "read-system": "allow",
    "read-sensitive": "allow",
    "edit-workspace": "allow",
    "edit-home": "allow",
    "edit-system": "allow",
    "edit-sensitive": "allow",
    "network-fetch": "allow",
    "network-send": "allow",
    "system-change": "allow",
    unknown: "allow",
  }),
}
