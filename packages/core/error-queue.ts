export type ReportedError = {
  id: string
  message: string
  reportedAt: number
}

/**
 * 按上报顺序保存核心错误，并为当前仅显示一项的界面提供最新错误。
 * 所有修改均为同步操作，异步任务并发完成时不会发生读改写覆盖。
 */
export class CoreErrorQueue {
  readonly #limit: number
  readonly #entries: ReportedError[] = []
  #visible: ReportedError | undefined

  constructor(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("错误队列容量必须是正整数")
    this.#limit = limit
  }

  /** 上报错误并将其设为当前界面显示项。 */
  report(message: string): ReportedError {
    const entry = { id: crypto.randomUUID(), message, reportedAt: Date.now() }
    this.#entries.push(entry)
    if (this.#entries.length > this.#limit) this.#entries.splice(0, this.#entries.length - this.#limit)
    this.#visible = entry
    return entry
  }

  /** 清除当前显示项；历史队列仍保留供后续扩展读取。 */
  clearVisible(): void {
    this.#visible = undefined
  }

  /** 返回当前应显示的最新错误。 */
  visible(): ReportedError | undefined {
    return this.#visible
  }

  /** 返回错误历史副本，避免调用方修改队列。 */
  entries(): ReportedError[] {
    return this.#entries.map((entry) => ({ ...entry }))
  }
}
