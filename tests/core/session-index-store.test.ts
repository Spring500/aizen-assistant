import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import lockfile from "proper-lockfile"
import { SessionIndexStore } from "../../packages/core/session-index-store.ts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function entry(sessionId: string) {
  return {
    size: 1,
    birthtimeMs: 2,
    mtimeMs: 3,
    summary: {
      sessionId,
      name: "",
      cwd: "E:\\project",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      preview: sessionId,
    },
  }
}

async function makePath() {
  const directory = await mkdtemp(join(tmpdir(), "aizen-index-"))
  directories.push(directory)
  return join(directory, "session-index.json")
}

describe("会话摘要索引存储", () => {
  test("多实例并发更新不同项目不会覆盖", async () => {
    const path = await makePath()
    await Promise.all([
      new SessionIndexStore(path).updateProject("project-a", { a: entry("a") }),
      new SessionIndexStore(path).updateProject("project-b", { b: entry("b") }),
    ])
    const index = JSON.parse(await readFile(path, "utf8"))
    expect(Object.keys(index.projects).sort()).toEqual(["project-a", "project-b"])
  })

  test("两个进程并发更新不同项目不会覆盖", async () => {
    const path = await makePath()
    const worker = join(import.meta.dir, "session-index-worker.ts")
    const processes = [
      Bun.spawn([process.execPath, "run", worker, path, "process-a", "a"]),
      Bun.spawn([process.execPath, "run", worker, path, "process-b", "b"]),
    ]
    expect(await Promise.all(processes.map((process) => process.exited))).toEqual([0, 0])
    const index = JSON.parse(await readFile(path, "utf8"))
    expect(Object.keys(index.projects).sort()).toEqual(["process-a", "process-b"])
  })

  test("过期锁可恢复且残留临时文件会清理", async () => {
    const path = await makePath()
    await writeFile(path, "{}")
    const lockPath = path.replace(/\.json$/, ".lock")
    const release = await lockfile.lock(path, { realpath: false, lockfilePath: lockPath, stale: 1000, update: 1000 })
    await release()
    await mkdir(lockPath)
    const expired = new Date(Date.now() - 60_000)
    await utimes(lockPath, expired, expired)
    const temporary = `${path}.leftover.tmp`
    await writeFile(temporary, "残留")

    expect(await new SessionIndexStore(path).updateProject("project", { a: entry("a") })).toEqual([])
    await expect(readFile(temporary)).rejects.toThrow()
  })

  test("Windows独占句柄下验证读取、替换和旧索引完整性", async () => {
    if (process.platform !== "win32") return
    const path = await makePath()
    const store = new SessionIndexStore(path)
    await store.updateProject("existing", { a: entry("a") })
    const ready = `${path}.ready`
    const release = `${path}.release`
    const scriptPath = `${path}.hold.ps1`
    await writeFile(
      scriptPath,
      [
        "$stream=[IO.File]::Open($args[0],[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)",
        "try {",
        "  [IO.File]::WriteAllText($args[1],'ready')",
        "  while (-not (Test-Path $args[2])) { Start-Sleep -Milliseconds 10 }",
        "} finally { $stream.Dispose() }",
      ].join("\n"),
    )
    const holder = Bun.spawn(["powershell.exe", "-NoProfile", "-File", scriptPath, path, ready, release], {
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      let held = false
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          await readFile(ready)
          held = true
          break
        } catch {
          await Bun.sleep(10)
        }
      }
      expect(held).toBe(true)
      await expect(readFile(path, "utf8")).rejects.toThrow()

      const warnings = await store.updateProject("blocked", { b: entry("b") })
      await writeFile(release, "release")
      expect(await holder.exited).toBe(0)
      const stderr = await new Response(holder.stderr).text()
      expect(stderr).toBe("")

      const index = JSON.parse(await readFile(path, "utf8"))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("会话摘要缓存更新失败")
      expect(warnings[0]).toContain("会话文件未受影响")
      expect(Object.keys(index.projects)).toEqual(["existing"])
      expect(index.projects.existing.a.summary.sessionId).toBe("a")
    } finally {
      await writeFile(release, "release").catch(() => {})
      holder.kill()
      await holder.exited
      await Promise.all([ready, release, scriptPath].map((file) => rm(file, { force: true })))
    }
  })

  test("锁等待失败返回警告且旧索引保持有效", async () => {
    const path = await makePath()
    const store = new SessionIndexStore(path)
    await store.updateProject("existing", { a: entry("a") })
    const release = await lockfile.lock(path, {
      realpath: false,
      lockfilePath: path.replace(/\.json$/, ".lock"),
      stale: 60_000,
      update: 20_000,
    })
    try {
      const warnings = await store.updateProject("blocked", { b: entry("b") })
      expect(warnings[0]).toContain("会话摘要缓存更新失败")
      expect(JSON.parse(await readFile(path, "utf8")).projects.existing).toBeDefined()
    } finally {
      await release()
    }
  }, 10_000)
})
