import { expect, test } from "bun:test"
import { parse } from "yaml"

const sha = /^[0-9a-f]{40}$/

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
