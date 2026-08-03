import type { CoreCommand, CoreCommandResult, CorePort } from "../../packages/core/types.ts"
import type { ModelReference } from "../../packages/core/session-format.ts"

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

/**
 * 发送失败前编辑器已经清空，因此该流程在成功前始终持有原草稿。
 * 模型或视图失效时先让用户重新选择，再重试原消息；其它错误或取消都会恢复原文。
 */
export async function sendPromptWithRecovery(input: {
  core: CorePort
  text: string
  chooseModel: () => Promise<ModelReference | undefined>
  chooseView: () => Promise<string | null | undefined>
  present: ErrorPresenter
  restoreDraft: (text: string) => void
}): Promise<CoreCommandResult> {
  const dispatch = async (command: CoreCommand): Promise<CoreCommandResult> => {
    try {
      return await input.core.dispatch(command)
    } catch (error) {
      return { ok: false, error: { code: "UNEXPECTED_ERROR", message: errorMessage(error), severity: "error" } }
    }
  }
  const fail = async (result: Exclude<CoreCommandResult, { ok: true }>, title: string) => {
    input.restoreDraft(input.text)
    await input.present(title, result.error.message)
    return result
  }

  const sent = await dispatch({ type: "send_prompt", text: input.text })
  if (sent.ok) return sent
  if (sent.error.code === "MODEL_SELECTION_REQUIRED") {
    const model = await input.chooseModel()
    if (!model) {
      input.restoreDraft(input.text)
      return sent
    }
    const selected = await dispatch({ type: "set_model", model })
    if (!selected.ok) return fail(selected, "切换模型失败")
  } else if (sent.error.code === "VIEW_SELECTION_REQUIRED") {
    const viewId = await input.chooseView()
    if (viewId === undefined) {
      input.restoreDraft(input.text)
      return sent
    }
    const selected = await dispatch({ type: "set_view", viewId })
    if (!selected.ok) return fail(selected, "切换视图失败")
  } else return fail(sent, "发送消息失败")

  const retried = await dispatch({ type: "send_prompt", text: input.text })
  if (!retried.ok) return fail(retried, "发送消息失败")
  return retried
}
