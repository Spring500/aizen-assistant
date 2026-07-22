import { type CliRenderer, createCliRenderer, type KeyEvent, type PasteEvent, TextRenderable } from "@opentui/core"

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
 * 支持逐字符输入、Backspace 删除，以及终端的粘贴（Ctrl+V / 右键粘贴等）。
 * 粘贴内容里的换行会被剔除，因为这是单行输入框。
 *
 * 输入完成后该行保留在屏幕上（形成问答记录），仅停止监听按键与粘贴事件。
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
    // 按当前 value 重新渲染这一行；mask 模式下用等长的 "•" 代替明文。
    const render = () => {
      display.content = `${label}${options.mask ? "•".repeat(value.length) : value}`
    }
    render()

    // 提交（按 Enter）时统一走这里，停止监听按键与粘贴，避免事件泄漏。
    const cleanup = () => {
      renderer.keyInput.off("keypress", onKeyPress)
      renderer.keyInput.off("paste", onPaste)
    }

    const onKeyPress = (key: KeyEvent) => {
      if (key.name === "return") {
        cleanup()
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

    const onPaste = (event: PasteEvent) => {
      const pastedText = new TextDecoder().decode(event.bytes).replace(/\r?\n/g, "")
      value += pastedText
      render()
    }

    renderer.keyInput.on("keypress", onKeyPress)
    renderer.keyInput.on("paste", onPaste)
  })
}
