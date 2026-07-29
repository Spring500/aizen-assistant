import { SessionIndexStore } from "../../packages/core/session-index-store.ts"

const [path, project, session] = process.argv.slice(2)
if (!path || !project || !session) throw new Error("缺少索引 worker 参数")
const store = new SessionIndexStore(path)
const warnings = await store.updateProject(project, {
  [session]: {
    size: 1,
    birthtimeMs: 1,
    mtimeMs: 1,
    summary: {
      sessionId: session,
      name: project,
      cwd: project,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      preview: session,
    },
  },
})
if (warnings.length > 0) throw new Error(warnings.join("；"))
