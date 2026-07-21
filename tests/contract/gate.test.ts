import { expect, test } from "bun:test"
import { isGatePassed, runSelfTest } from "../../apps/tui/gate.ts"

test("pi、内联扩展、视图、OpenTUI、Photon 和 HTTP 链路全部可用", async () => {
  const report = await runSelfTest()

  expect(report.piSdk.passed).toBeTrue()
  expect(report.openTui.passed).toBeTrue()
  expect(report.photonWasm.passed).toBeTrue()
  expect(report.mockServer.passed).toBeTrue()
  expect(isGatePassed(report)).toBeTrue()
})
