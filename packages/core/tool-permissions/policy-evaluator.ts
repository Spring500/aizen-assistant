import type {
  ConfigurablePermissionKey,
  PermissionClaim,
  PermissionDisposition,
  PermissionPolicy,
} from "./policy-types.ts"

export type PermissionClassification = { kind: "claims"; claims: PermissionClaim[] } | { kind: "unknown" }

export type PermissionPolicyEvaluation = {
  disposition: PermissionDisposition
  decisiveKey?: ConfigurablePermissionKey | "violation"
  claims: PermissionClaim[]
}

const dispositionRank: Record<PermissionDisposition, number> = {
  allow: 0,
  aiReview: 1,
  needHumanReview: 2,
  deny: 3,
}

/** 将最终分类结果映射为处置档位；策略缺项保守地按必须人工处理。 */
export function evaluatePermissionPolicy(
  classification: PermissionClassification,
  policy: PermissionPolicy,
): PermissionPolicyEvaluation {
  if (classification.kind === "unknown") {
    return {
      disposition: policy.dispositions.unknown ?? "needHumanReview",
      decisiveKey: "unknown",
      claims: [],
    }
  }
  const violation = classification.claims.find((claim) => claim.tag === "violation")
  if (violation) {
    return {
      disposition: "deny",
      decisiveKey: "violation",
      claims: classification.claims,
    }
  }
  if (classification.claims.length === 0) return { disposition: "allow", claims: [] }

  let disposition: PermissionDisposition = "allow"
  let decisiveKey: ConfigurablePermissionKey | undefined
  for (const claim of classification.claims) {
    const key = claim.tag as ConfigurablePermissionKey
    const candidate = policy.dispositions[key] ?? "needHumanReview"
    if (decisiveKey === undefined || dispositionRank[candidate] > dispositionRank[disposition]) {
      disposition = candidate
      decisiveKey = key
    }
  }
  return {
    disposition,
    ...(decisiveKey === undefined ? {} : { decisiveKey }),
    claims: classification.claims,
  }
}
