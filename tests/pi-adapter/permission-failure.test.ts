import { expect, test } from "bun:test"
import { permissionFailureMessage } from "../../packages/pi-adapter/permission-failure.ts"

test("审核拒绝向 Agent 附加实际发生的原因链", () => {
  expect(
    permissionFailureMessage({
      type: "deny",
      source: "human",
      reason: "Operation denied: User denied permission. Reason: 不允许发布",
      reviewSteps: [
        { stage: "validator", decision: "needAiReview", reason: "命令会执行发布脚本" },
        { stage: "ai", decision: "needHumanReview", reason: "无法确认目标环境" },
        { stage: "human", decision: "deny", reason: "不允许发布" },
      ],
    }),
  ).toBe(`Operation denied: User denied permission. Reason: 不允许发布

Permission review:
1. Validator: needAiReview
   Reason: 命令会执行发布脚本
2. AI reviewer: needHumanReview
   Reason: 无法确认目标环境
3. User: deny
   Reason: 不允许发布`)
})

test("没有原因链时保持原始失败文本", () => {
  expect(permissionFailureMessage({ type: "aborted", reason: "Operation aborted: User aborted the turn." })).toBe(
    "Operation aborted: User aborted the turn.",
  )
})
