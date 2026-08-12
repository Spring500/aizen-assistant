import { expect } from "bun:test"
import type { CatalogEntry, CatalogResult } from "../../packages/core/resource-catalog.ts"

/** 所有目录型 Store 共用的故障注入断言：坏条目必须可见，健康条目仍可使用。 */
export function expectCatalogIsolation<T extends CatalogEntry>(
  catalog: CatalogResult<T>,
  healthyEntryId: string,
  brokenEntryId: string,
): void {
  const healthy = catalog.entries.find((entry) => entry.entryId === healthyEntryId)
  const broken = catalog.entries.find((entry) => entry.entryId === brokenEntryId)
  expect(healthy).toBeDefined()
  expect(healthy?.state).toBe("healthy")
  expect(healthy?.capabilities.canOpen).toBe(true)
  expect(broken).toBeDefined()
  expect(broken?.state).not.toBe("healthy")
  expect(broken?.issues.length).toBeGreaterThan(0)
}
