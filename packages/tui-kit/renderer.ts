import { type CliRenderer, createCliRenderer } from "@opentui/core"

/** tui-kit 对业务层暴露的渲染器类型，避免业务代码直接依赖 OpenTUI。 */
export type TuiRenderer = CliRenderer

export async function createAizenRenderer(): Promise<CliRenderer> {
  return createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "split-footer",
    footerHeight: 9,
    externalOutputMode: "capture-stdout",
    useMouse: false,
  })
}

function safeTerminalTitle(title: string): string {
  return Array.from(title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")).slice(0, 120).join("").trim()
}

/** 设置经过控制字符过滤和长度限制的终端标题。 */
export function setAizenTerminalTitle(renderer: CliRenderer, title: string): void {
  renderer.setTerminalTitle(safeTerminalTitle(title) || "AizenAssistant")
}

export function destroyRenderer(renderer: CliRenderer): void {
  renderer.destroy()
}
