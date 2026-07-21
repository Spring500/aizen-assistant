import { expect, test } from "bun:test"
import { isGatePassed, runSelfTest } from "../../apps/architecture-gate/src/self-test.ts"

test("pi、内联扩展、视图、OpenTUI 和 Photon 全部可用", async () => {
  const report = await runSelfTest()

  expect(report.piSdk.passed).toBeTrue()
  expect(report.openTui.passed).toBeTrue()
  expect(report.photonWasm.passed).toBeTrue()
  expect(isGatePassed(report)).toBeTrue()
})
