import { expect, test } from "bun:test"
import { parse } from "yaml"

const sha = /^[0-9a-f]{40}$/

type Workflow = {
  jobs: Record<
    string,
    {
      steps: Array<{
        uses?: string
        run?: string
        with?: Record<string, string>
      }>
    }
  >
}

async function readWorkflow(path: string): Promise<Workflow> {
  return parse(await Bun.file(path).text()) as Workflow
}

for (const path of [".github/workflows/ci.yml", ".github/workflows/pr-title.yml"]) {
  test(`${path} 的第三方 action 固定完整 SHA`, async () => {
    const workflow = await readWorkflow(path)
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (!step.uses) continue
        const ref = step.uses.split("@").at(-1)
        expect(ref).toMatch(sha)
      }
    }
  })
}

test("主 CI 跨运行缓存 Bun 下载包", async () => {
  const workflow = await readWorkflow(".github/workflows/ci.yml")
  const cache = workflow.jobs.verify?.steps.find((step) => step.uses?.startsWith("actions/cache@"))

  expect(cache?.with?.path).toBe("~/.bun/install/cache")
  expect(cache?.with?.key).toContain("runner.os")
  expect(cache?.with?.key).toContain(".bun-version")
  expect(cache?.with?.key).toContain("bun.lock")
})

test("PR 标题检查不安装项目依赖", async () => {
  const workflow = await readWorkflow(".github/workflows/pr-title.yml")
  const commands = workflow.jobs.validate?.steps.flatMap((step) => step.run ?? []) ?? []

  expect(commands.some((command) => command.includes("bun install"))).toBe(false)
})
