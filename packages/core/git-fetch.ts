import { existsSync } from "node:fs"
import fs from "node:fs"
import { join } from "node:path"

import git from "isomorphic-git"
import http from "isomorphic-git/http/node"

/** 拉取策略：首次 clone，之后 fetch 并强制检出目标引用，保证缓存目录与远端一致。 */
export type FetchRepo = (cacheDir: string, url: string, ref?: string) => Promise<void>

export async function fetchRepo(cacheDir: string, url: string, ref?: string): Promise<void> {
  if (!existsSync(join(cacheDir, ".git"))) {
    await git.clone({ fs, http, dir: cacheDir, url, ref, singleBranch: true, depth: 1 })
    return
  }
  await git.fetch({ fs, http, dir: cacheDir, ref, singleBranch: true, depth: 1 })
  if (ref) await git.checkout({ fs, dir: cacheDir, ref, force: true })
}
