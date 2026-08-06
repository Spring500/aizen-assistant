import { afterEach, expect, test } from "bun:test"
import { exists, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "../../packages/core/session-store.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("跨进程持有会话租约时第二个进程无法打开", async () => {
  const root = await mkdtemp(join(tmpdir(), "aizen-session-process-lock-"))
  roots.push(root)
  const session = new SessionStore(root)
  await session.create({ sessionId: "s1", cwd: root, createdAt: "2026-07-23T10:00:00.000Z" })
  await session.open("s1")
  const probe = join(root, "probe.ts")
  await writeFile(
    probe,
    `import { SessionStore } from ${JSON.stringify(join(import.meta.dir, "../../packages/core/session-store.ts"))};\n` +
      `const store = new SessionStore(${JSON.stringify(root)});\n` +
      `try { await store.open("s1"); console.log("opened") } catch (error) { console.log(error instanceof Error ? error.message : String(error)) }\n`,
  )
  const child = Bun.spawn([process.execPath, "run", probe], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  expect(output.trim()).toBe("会话正在被其他 Agent 使用：s1")
  expect(await exists(join(root, ".s1.session"))).toBe(false)
  await session.close()
})
