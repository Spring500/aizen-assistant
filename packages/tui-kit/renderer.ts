import { type CliRenderer, createCliRenderer } from "@opentui/core"

export async function createAizenRenderer(): Promise<CliRenderer> {
  return createCliRenderer({ exitOnCtrlC: false, screenMode: "alternate-screen" })
}

export function destroyRenderer(renderer: CliRenderer): void {
  renderer.destroy()
}
