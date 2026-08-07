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
