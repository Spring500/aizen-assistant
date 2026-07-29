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

export function destroyRenderer(renderer: CliRenderer): void {
  renderer.destroy()
}
