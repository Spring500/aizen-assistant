import { describe, expect, test } from "bun:test"
import { CoreErrorQueue } from "../../packages/core/error-queue.ts"

describe("核心错误队列", () => {
  test("并发上报不丢失且界面显示最新项", async () => {
    const queue = new CoreErrorQueue()
    await Promise.all([
      Promise.resolve().then(() => queue.report("第一项")),
      Promise.resolve().then(() => queue.report("第二项")),
      Promise.resolve().then(() => queue.report("第三项")),
    ])

    expect(queue.entries().map((entry) => entry.message)).toEqual(["第一项", "第二项", "第三项"])
    expect(queue.visible()?.message).toBe("第三项")
    expect(queue.entries()).toHaveLength(3)
  })
})
