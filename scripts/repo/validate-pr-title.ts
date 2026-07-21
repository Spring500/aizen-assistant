const types = ["feat", "fix", "refactor", "perf", "test", "docs", "build", "ci", "chore", "revert"]
const scopes = ["core", "pi-adapter", "protocol", "tui", "desktop", "tauri", "repo", "release", "pi"]
const pattern = new RegExp(`^(${types.join("|")})(\\((${scopes.join("|")})\\))?!?: .+$`)

export function validatePrTitle(title: string): string | undefined {
  if (!pattern.test(title)) return "PR 标题不符合 Conventional Commits"
  if (!/[\u3400-\u9fff]/u.test(title)) return "PR 标题说明必须包含中文"
  return undefined
}

if (import.meta.main) {
  const title = process.argv.slice(2).join(" ")
  const error = validatePrTitle(title)
  if (error) {
    console.error(error)
    process.exitCode = 1
  } else {
    console.log("PR 标题检查通过")
  }
}
