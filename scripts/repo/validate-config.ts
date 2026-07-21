import { $ } from "bun"

type PackageConfig = {
  packageManager?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  overrides?: Record<string, string>
}

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function validatePackageConfig(config: PackageConfig): string[] {
  const errors: string[] = []
  if (!/^bun@\d+\.\d+\.\d+$/.test(config.packageManager ?? "")) {
    errors.push("packageManager 必须锁定 Bun 精确版本")
  }

  for (const group of ["dependencies", "devDependencies", "overrides"] as const) {
    for (const [name, version] of Object.entries(config[group] ?? {})) {
      if (!exactVersion.test(version) && version !== "workspace:*") {
        errors.push(`${group}.${name} 必须锁定精确版本`)
      }
    }
  }
  return errors
}

export function validatePrivatePaths(paths: string[]): string[] {
  return paths
    .filter((path) => path.startsWith(".private/") || path.startsWith("docs/design/") || path === "方案与路线图.md")
    .map((path) => `${path} 不得进入 Git`)
}

async function main(): Promise<void> {
  const config = (await Bun.file("package.json").json()) as PackageConfig
  const tracked = (await $`git ls-files`.text()).trim().split(/\r?\n/).filter(Boolean)
  const errors = [...validatePackageConfig(config), ...validatePrivatePaths(tracked)]
  if (errors.length > 0) {
    for (const error of errors) console.error(error)
    process.exitCode = 1
    return
  }
  console.log("仓库配置检查通过")
}

if (import.meta.main) await main()
