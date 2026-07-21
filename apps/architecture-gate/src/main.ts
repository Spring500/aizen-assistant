import { isGatePassed, runSelfTest } from "./self-test.ts"

if (!process.argv.includes("--self-test")) {
  console.error("必须使用 --self-test 运行架构门禁")
  process.exit(2)
}

const checks = await runSelfTest()
const passed = isGatePassed(checks)
console.log(JSON.stringify({ passed, checks }))
if (!passed) process.exitCode = 1
