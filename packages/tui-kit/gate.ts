import { createTestRenderer } from "@opentui/core/testing"
import { TextRenderable } from "@opentui/core"

export async function checkOpenTui(): Promise<string> {
  const setup = await createTestRenderer({ width: 48, height: 8 })
  try {
    setup.renderer.root.add(new TextRenderable(setup.renderer, { id: "gate", content: "AizenAssistant OpenTUI" }))
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    if (!frame.includes("AizenAssistant OpenTUI")) throw new Error("OpenTUI 帧缺少测试文本")
    return "OpenTUI native renderer=true"
  } finally {
    setup.renderer.destroy()
  }
}
