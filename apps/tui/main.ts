import { basename } from "node:path"
import { resolveDataDirectory } from "../../packages/core/paths.ts"
import { completeOnce } from "../../packages/pi-adapter/complete.ts"
import { parseArguments, usage } from "./args.ts"
import { runInteractiveApp } from "./interactive-app.ts"

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ReturnType<typeof parseArguments>
  try {
    parsed = parseArguments(args, process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(usage())
    return 2
  }

  if (parsed.mode === "plain") {
    try {
      const result = await completeOnce(parsed.values.baseUrl, parsed.values.apiKey, parsed.values.message)
      if (!result.text) {
        console.error(JSON.stringify({ stopReason: result.stopReason, errorMessage: result.errorMessage }))
        return 1
      }
      console.log(result.text)
      return 0
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("交互模式需要真实终端")
    return 1
  }
  try {
    const sourceMode = basename(process.execPath).toLowerCase().startsWith("bun")
    const dataDirectory = resolveDataDirectory(parsed.dataDirectory, process.execPath, process.cwd(), sourceMode)
    await runInteractiveApp({ cwd: process.cwd(), dataDirectory })
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) process.exitCode = await main()
