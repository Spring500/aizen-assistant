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
  /** 数据目录绝对路径：文件分类器据此保护数据目录内容。 */
  dataDirectory?: string
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
