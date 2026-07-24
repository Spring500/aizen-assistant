import { join, resolve } from "node:path"
import { main as runTui } from "../../apps/tui/main.ts"

export function developmentArguments(args: string[], root: string): string[] {
  return args.length > 0 ? args : ["--data-dir", join(root, ".aizen", "dev-data")]
}

export async function runDevelopmentTui(args: string[] = process.argv.slice(2)): Promise<number> {
  const root = resolve(import.meta.dir, "..", "..")
  process.chdir(root)
  return runTui(developmentArguments(args, root))
}

if (import.meta.main) process.exitCode = await runDevelopmentTui()
