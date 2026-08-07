import type { JsonValue } from "../session-format.ts"
import type { PermissionClaim, PermissionClassifyResult } from "./policy-types.ts"

export type PermissionClassifyInput = {
  toolName: string
  command?: string
  arguments: JsonValue
  cwd: string
}

export type PermissionClassifyContext = {
  workspaceRoot: string
  homeDirectory?: string
  sensitivePaths: string[]
  shell: string
  platform: string
}

export type PermissionClassifier = {
  id: string
  toolNames: string[]
  classify(
    input: PermissionClassifyInput,
    context: PermissionClassifyContext,
  ): PermissionClassifyResult | Promise<PermissionClassifyResult>
}

export type AttributedPermissionClaim = PermissionClaim & {
  classifierId: string
}

export type PermissionClassificationResult =
  | { kind: "claims"; claims: AttributedPermissionClaim[] }
  | { kind: "unknown" }
