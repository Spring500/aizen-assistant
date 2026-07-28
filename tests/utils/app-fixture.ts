import { cp, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type AppFixture = "empty" | "model-only" | "valid-view" | "invalid-view"

export async function copyAppFixture(name: AppFixture): Promise<string> {
  const destination = await mkdtemp(join(tmpdir(), `aizen-app-${name}-`))
  const source = join(import.meta.dir, "..", "fixtures", "app", name)
  await cp(source, destination, { recursive: true, force: true }).catch((error) => {
    if (name !== "empty") throw error
  })
  return destination
}
