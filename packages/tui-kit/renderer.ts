import { type CliRenderer, createCliRenderer } from "@opentui/core"

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
