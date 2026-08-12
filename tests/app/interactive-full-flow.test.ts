import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 60_000 })

async function runScenario(name: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "run", "tests/app/interactive-scenario.ts", name], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ name, exitCode, stdout, stderr }).toEqual({ name, exitCode: 0, stdout: "", stderr: "" })
}

// The product owns one TUI renderer per process. Each scenario therefore runs in its own child process.
// They are deliberately executed serially inside one test: Bun may run sibling tests concurrently, while
// OpenTUI's Windows native backend is not a resource we need or intend to stress concurrently in this suite.
test("真实完整 TUI 交互场景", async () => {
  await runScenario("invalid-model")
  await runScenario("no-views")
  await runScenario("throwing-create")
  await runScenario("recover-prompt")
  await runScenario("recover-view-prompt")
  await runScenario("open-incompatible")
})
