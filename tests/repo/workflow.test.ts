import { expect, test } from "bun:test"
import { parse } from "yaml"

const sha = /^[0-9a-f]{40}$/

type Workflow = {
  jobs: Record<string, { steps: Array<{ uses?: string; run?: string }> }>
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

test("PR 标题检查不安装项目依赖", async () => {
  const workflow = parse(await Bun.file(".github/workflows/pr-title.yml").text()) as Workflow
  const commands = workflow.jobs.validate?.steps.flatMap((step) => step.run ?? []) ?? []

  expect(commands.some((command) => command.includes("bun install"))).toBe(false)
})
