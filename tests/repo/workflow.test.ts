import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { parse } from "yaml"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

const sha = /^[0-9a-f]{40}$/

type Workflow = {
  jobs: Record<
    string,
    {
      "timeout-minutes"?: number
      steps: Array<{ uses?: string; run?: string; if?: string; with?: Record<string, string | number> }>
    }
  >
}

for (const path of [".github/workflows/ci.yml", ".github/workflows/pr-title.yml"]) {
  test(`${path} 的第三方 action 固定完整 SHA`, async () => {
    const workflow = parse(await Bun.file(path).text()) as {
      jobs: Record<string, { steps: Array<{ uses?: string }> }>
    }
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (!step.uses) continue
        const ref = step.uses.split("@").at(-1)
        expect(ref).toMatch(sha)
      }
    }
  })
}

test("主 CI 最多运行五分钟", async () => {
  const workflow = parse(await Bun.file(".github/workflows/ci.yml").text()) as Workflow

  expect(workflow.jobs.verify?.["timeout-minutes"]).toBe(5)
})

test("主 CI 配置测试诊断与失败产物上传", async () => {
  const workflow = parse(await Bun.file(".github/workflows/ci.yml").text()) as Workflow
  const steps = workflow.jobs.verify?.steps ?? []
  const diagnosticSetup = steps.find((step) => step.run?.includes("setup-test-diagnostics.ps1"))
  const diagnosticUpload = steps.find(
    (step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === "test-timeout-diagnostics",
  )

  expect(diagnosticSetup).toBeDefined()
  expect(diagnosticUpload?.if).toBe("failure()")
  expect(diagnosticUpload?.with?.["retention-days"]).toBe(7)
})

test("PR 标题检查不安装项目依赖", async () => {
  const workflow = parse(await Bun.file(".github/workflows/pr-title.yml").text()) as Workflow
  const commands = workflow.jobs.validate?.steps.flatMap((step) => step.run ?? []) ?? []

  expect(commands.some((command) => command.includes("bun install"))).toBe(false)
})
