import { basename, join } from "node:path"
import { dataDirectoryFromExecutable } from "../../packages/core/paths.ts"
import { completeOnce } from "../../packages/pi-adapter/complete.ts"
import { parseArguments, usage } from "./args.ts"
import { runInteractiveApp } from "./interactive-app.ts"

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArguments>
  try {
    parsed = parseArguments(process.argv.slice(2), process.env)
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
  if (!process.env.AIZEN_DATA_DIR && basename(process.execPath).toLowerCase().startsWith("bun")) {
    console.error("源码运行交互模式时必须设置 AIZEN_DATA_DIR")
    return 1
  }
  const dataDirectory = process.env.AIZEN_DATA_DIR
    ? join(process.env.AIZEN_DATA_DIR)
    : dataDirectoryFromExecutable(process.execPath)
  try {
    await runInteractiveApp({ cwd: process.cwd(), dataDirectory })
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

process.exitCode = await main()
