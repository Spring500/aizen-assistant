export type GateCheck = { passed: boolean; detail: string }
export type GateReport = {
  piSdk: GateCheck
  openTui: GateCheck
  photonWasm: GateCheck
  mockServer: GateCheck
}

export async function check(name: string, operation: () => Promise<string> | string): Promise<GateCheck> {
  try {
    return { passed: true, detail: await operation() }
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    return { passed: false, detail: `${name}: ${detail}` }
  }
}
