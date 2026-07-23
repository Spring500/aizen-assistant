import { expect, test } from "bun:test"
import { KeyEvent, parseKeypress } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createChatEditor } from "../../packages/tui-kit/editor.ts"

function emitKey(renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"], raw: string): void {
  const parsed = parseKeypress(raw)
  if (!parsed) throw new Error(`无法解析按键：${raw}`)
  renderer.keyInput.emit("keypress", new KeyEvent(parsed))
}

test("编辑器发送、中止和忙碌状态", async () => {
  const setup = await createTestRenderer({ width: 60, height: 8 })
  const submitted: string[] = []
  let aborted = 0
  try {
    const editor = createChatEditor(setup.renderer, {
      onSubmit: (value) => submitted.push(value),
      onAbort: () => aborted++,
      onQuit: () => {},
    })
    editor.input.setText("第一条")
    editor.input.submit()
    expect(submitted).toEqual(["第一条"])
    editor.setBusy(true)
    editor.input.setText("第二条")
    editor.input.submit()
    expect(submitted).toEqual(["第一条"])
    emitKey(setup.renderer, "\x1b")
    expect(aborted).toBe(1)
    editor.destroy()
  } finally {
    setup.renderer.destroy()
  }
})
