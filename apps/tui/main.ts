import { basename } from "node:path"
import { resolveDataDirectory } from "../../packages/core/paths.ts"
import { parseArguments, usage } from "./args.ts"
import { runInteractiveApp } from "./interactive-app.ts"

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ReturnType<typeof parseArguments>
  try {
    parsed = parseArguments(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(usage())
    return 2
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("交互模式需要真实终端")
    return 1
  }
  try {
    const sourceMode = basename(process.execPath).toLowerCase().startsWith("bun")
    const dataDirectory = resolveDataDirectory(parsed.dataDirectory, process.execPath, process.cwd(), sourceMode)
    await runInteractiveApp({
      cwd: process.cwd(),
      dataDirectory,
      collectPermissionGaps: parsed.collectPermissionGaps,
    })
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) process.exitCode = await main()
