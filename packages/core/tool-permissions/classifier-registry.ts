import type {
  AttributedPermissionClaim,
  PermissionClassificationResult,
  PermissionClassifier,
  PermissionClassifyContext,
  PermissionClassifyInput,
} from "./classifier-types.ts"

export class PermissionClassifierRegistry {
  readonly #classifiers = new Map<string, PermissionClassifier>()
  readonly #errors: string[] = []

  /** 注册内置分类器；已有同 ID 项时拒绝，防止内置定义静默互相覆盖。 */
  registerBuiltin(classifier: PermissionClassifier): void {
    this.#validate(classifier)
    if (this.#classifiers.has(classifier.id)) throw new Error(`权限分类器重复注册：${classifier.id}`)
    this.#classifiers.set(classifier.id, classifier)
  }

  /** 注册用户分类器；相同 ID 的用户项会完全替换内置或旧用户分类器。 */
  registerUser(classifier: PermissionClassifier): void {
    this.#validate(classifier)
    this.#classifiers.set(classifier.id, classifier)
  }

  /** 对匹配工具运行全部有效分类器并合并断言；全员弃权时返回 unknown。 */
  async classify(
    input: PermissionClassifyInput,
    context: PermissionClassifyContext,
  ): Promise<PermissionClassificationResult> {
    const claims: AttributedPermissionClaim[] = []
    let claimed = false
    for (const classifier of this.#classifiers.values()) {
      if (!classifier.toolNames.includes(input.toolName) && !classifier.toolNames.includes("*")) continue
      try {
        const result = await classifier.classify(input, context)
        if (result.kind === "abstain") continue
        claimed = true
        claims.push(...result.claims.map((claim) => ({ ...claim, classifierId: classifier.id })))
      } catch (error) {
        this.#errors.push(`分类器 ${classifier.id} 执行失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return claimed ? { kind: "claims", claims } : { kind: "unknown" }
  }

  /** 取出分类器执行期间产生的错误，供 Core 显著呈现。 */
  takeErrors(): string[] {
    return this.#errors.splice(0)
  }

  #validate(classifier: PermissionClassifier): void {
    if (!classifier.id.trim()) throw new Error("权限分类器 ID 不能为空")
    if (!/^[a-z0-9-]+\/[a-z0-9-]+@\d+$/.test(classifier.id)) throw new Error(`权限分类器 ID 无效：${classifier.id}`)
    if (classifier.toolNames.length === 0 || classifier.toolNames.some((name) => !name.trim()))
      throw new Error(`权限分类器 ${classifier.id} 必须声明工具名称`)
  }
}
