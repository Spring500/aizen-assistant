import type { CoreCommand, CoreCommandResult, CorePort } from "../../packages/core/types.ts"

export type ErrorPresenter = (title: string, message: string) => Promise<void>

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function dispatchOrPresent(
  core: CorePort,
  command: CoreCommand,
  title: string,
  present: ErrorPresenter,
): Promise<CoreCommandResult> {
  try {
    const result = await core.dispatch(command)
    if (!result.ok) await present(title, result.error.message)
    return result
  } catch (error) {
    await present(title, errorMessage(error))
    return { ok: false, error: { code: "UNEXPECTED_ERROR", message: errorMessage(error), severity: "error" } }
  }
}

export class ActionQueue {
  #pending = Promise.resolve()
  readonly #present: ErrorPresenter

  constructor(present: ErrorPresenter) {
    this.#present = present
  }

  run(operation: () => Promise<unknown>): void {
    this.#pending = this.#pending
      .then(operation)
      .catch(async (error) => this.#present("操作失败", errorMessage(error)))
      .then(() => {})
  }

  flush(): Promise<void> {
    return this.#pending
  }
}
