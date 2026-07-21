import { PhotonImage } from "@silvia-odwyer/photon-node"
import { type GateReport, check } from "../../../packages/core/src/gate-types.ts"
import { checkPiSdk, checkMockServer } from "../../../packages/pi-adapter/src/gate.ts"
import { checkOpenTui } from "../../../packages/tui-kit/src/gate.ts"

function checkPhoton(): string {
  const image = new PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1)
  try {
    if (image.get_width() !== 1 || image.get_height() !== 1) throw new Error("PhotonImage 尺寸不正确")
    const png = image.get_bytes()
    if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
      throw new Error("Photon WASM 未生成 PNG")
    }
    return `Photon WASM=true; pngBytes=${png.byteLength}`
  } finally {
    image.free()
  }
}

export async function runSelfTest(): Promise<GateReport> {
  return {
    piSdk: await check("piSdk", checkPiSdk),
    openTui: await check("openTui", checkOpenTui),
    photonWasm: await check("photonWasm", checkPhoton),
    mockServer: await check("mockServer", checkMockServer),
  }
}

export function isGatePassed(report: GateReport): boolean {
  return Object.values(report).every((item) => item.passed)
}
