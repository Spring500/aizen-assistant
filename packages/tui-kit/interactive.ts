import { type CliRenderer, createCliRenderer, type KeyEvent, TextRenderable } from "@opentui/core"

export type PromptOptions = {
  /** 是否用 "•" 遮盖输入内容（用于 api-key 等敏感字段） */
  mask?: boolean
}

/**
 * 创建一个用于交互式命令行输入的 OpenTUI 渲染器。
 *
 * 使用 `main-screen` 而非默认的 alternate-screen，确保交互过程中的提示与
 * 输入历史保留在终端正常滚动区，不会在渲染器销毁时被恢复为空白覆盖。
 */
export async function createInteractiveRenderer(): Promise<CliRenderer> {
  return createCliRenderer({ exitOnCtrlC: true, screenMode: "main-screen" })
}

/** 在渲染器 root 下追加一行只读文本。 */
export function showLine(renderer: CliRenderer, id: string, content: string): void {
  renderer.root.add(new TextRenderable(renderer, { id, content }))
}

/**
 * 显示一行 `label` 前缀的单行输入框，等待用户按下 Enter 后返回输入内容。
 *
 * 输入完成后该行保留在屏幕上（形成问答记录），仅停止监听按键事件。
 */
export function promptLine(
  renderer: CliRenderer,
  id: string,
  label: string,
  options: PromptOptions = {},
): Promise<string> {
  return new Promise((resolve) => {
    const display = new TextRenderable(renderer, { id, content: label })
    renderer.root.add(display)

    let value = ""
    const render = () => {
      display.content = `${label}${options.mask ? "•".repeat(value.length) : value}`
    }
    render()

    const onKeyPress = (key: KeyEvent) => {
      if (key.name === "return") {
        renderer.keyInput.off("keypress", onKeyPress)
        resolve(value)
        return
      }
      if (key.name === "backspace") {
        value = value.slice(0, -1)
      } else if (!key.ctrl && !key.meta && key.sequence.length === 1) {
        value += key.sequence
      }
      render()
    }
    renderer.keyInput.on("keypress", onKeyPress)
  })
}
