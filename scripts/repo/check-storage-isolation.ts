import { filesystemAccessPolicy, persistentResourceRegistry } from "../../packages/core/storage-registry.ts"

function normalized(path: string): string {
  return path.replaceAll("\\", "/")
}

export async function checkStorageIsolation(files?: Record<string, string>): Promise<string[]> {
  const sources = files ?? {}
  if (!files) {
    const glob = new Bun.Glob("{packages,apps}/**/*.ts")
    for await (const path of glob.scan({ cwd: process.cwd(), onlyFiles: true }))
      sources[normalized(path)] = await Bun.file(path).text()
  }
  const errors: string[] = []
  const registrations = persistentResourceRegistry.flatMap((resource) =>
    resource.implementations.map((implementation) => ({ ...implementation, resource })),
  )

  for (const [rawPath, source] of Object.entries(sources)) {
    const path = normalized(rawPath)
    if (/from\s+["']node:fs(?:\/promises)?["']/.test(source) && !filesystemAccessPolicy[path])
      errors.push(`${path} 直接访问文件系统但未登记`)

    for (const match of source.matchAll(/export\s+class\s+(\w+(?:Store|Recorder))\b/g)) {
      const symbol = match[1] ?? ""
      if (!registrations.some((entry) => entry.file === path && entry.symbol === symbol))
        errors.push(`${path} 导出的 ${symbol} 未登记为持久化资源`)
    }

    for (const registration of registrations) {
      if (!new RegExp(`\\bnew\\s+${registration.symbol}\\b`).test(source)) continue
      if (!registration.resource.constructionFiles.includes(path))
        errors.push(`${path} 直接构造 ${registration.symbol}；应通过已登记的 DataStores 组合根`)
    }
  }
  return errors
}

async function main(): Promise<void> {
  const errors = await checkStorageIsolation()
  if (errors.length > 0) {
    for (const error of errors) console.error(error)
    process.exitCode = 1
    return
  }
  console.log("持久化隔离检查通过")
}

if (import.meta.main) await main()
