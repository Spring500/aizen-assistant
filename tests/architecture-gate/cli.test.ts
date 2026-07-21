import { expect, test } from "bun:test"

test("CLI 输出单行 JSON 门禁报告", () => {
  const result = Bun.spawnSync({ cmd: ["bun", "run", "apps/architecture-gate/src/main.ts", "--self-test"] })
  expect(result.exitCode).toBe(0)
  const output = new TextDecoder().decode(result.stdout).trim().split(/\r?\n/).at(-1)
  expect(output).toBeDefined()
  const report = JSON.parse(output ?? "{}")
  expect(report.passed).toBeTrue()
  expect(report.checks.piSdk.passed).toBeTrue()
  expect(report.checks.openTui.passed).toBeTrue()
  expect(report.checks.photonWasm.passed).toBeTrue()
  expect(report.checks.mockServer.passed).toBeTrue()
})
