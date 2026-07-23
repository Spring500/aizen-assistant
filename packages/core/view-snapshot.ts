import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"

export type ViewSnapshot = {
  viewId: string
  contentHash: string
  directory: string
}

type ViewFile = { relativePath: string; absolutePath: string; bytes: Uint8Array }

async function collectFiles(root: string, directory = root): Promise<ViewFile[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: ViewFile[] = []
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name)
    const status = await lstat(absolutePath)
    if (status.isSymbolicLink()) throw new Error(`视图中禁止使用符号链接：${relative(root, absolutePath)}`)
    if (status.isDirectory()) files.push(...(await collectFiles(root, absolutePath)))
    else if (status.isFile()) {
      files.push({
        relativePath: relative(root, absolutePath).replace(/\\/g, "/"),
        absolutePath,
        bytes: await readFile(absolutePath),
      })
    }
  }
  return files
}

function validateRelativePath(path: string): void {
  if (path === "view.json" || path === "system.md" || path === "AGENTS.md" || path.startsWith("skills/")) return
  throw new Error(`视图包含不支持的路径：${path}`)
}

export async function snapshotViewDirectory(source: string, destinationRoot: string): Promise<ViewSnapshot> {
  const files = (await collectFiles(source)).sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  const viewFile = files.find((file) => file.relativePath === "view.json")
  if (!viewFile) throw new Error("视图缺少 view.json")
  for (const file of files) validateRelativePath(file.relativePath)

  const metadata = JSON.parse(new TextDecoder().decode(viewFile.bytes)) as unknown
  if (typeof metadata !== "object" || metadata === null || !("id" in metadata) || typeof metadata.id !== "string") {
    throw new Error("view.json 缺少字符串 id")
  }

  const hasher = new Bun.CryptoHasher("sha256")
  for (const file of files) {
    hasher.update(file.relativePath)
    hasher.update(new Uint8Array([0]))
    hasher.update(file.bytes)
    hasher.update(new Uint8Array([0]))
  }
  const digest = hasher.digest("hex")
  const destination = join(destinationRoot, digest)

  await mkdir(destinationRoot, { recursive: true })
  try {
    const status = await lstat(destination)
    if (status.isDirectory()) return { viewId: metadata.id, contentHash: `sha256:${digest}`, directory: destination }
    throw new Error(`视图副本路径不是目录：${destination}`)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  }

  const temporary = await mkdtemp(join(destinationRoot, `.tmp-${basename(destination)}-`))
  try {
    for (const file of files) {
      const target = join(temporary, file.relativePath)
      await mkdir(dirname(target), { recursive: true })
      await cp(file.absolutePath, target, { dereference: false, errorOnExist: true })
    }
    await writeFile(
      join(temporary, "snapshot.json"),
      `${JSON.stringify({ version: 1, viewId: metadata.id, contentHash: `sha256:${digest}`, files: files.map((file) => file.relativePath) }, null, 2)}\n`,
    )
    try {
      await rename(temporary, destination)
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY"))
        throw error
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return { viewId: metadata.id, contentHash: `sha256:${digest}`, directory: destination }
}

export async function saveEmptyViewSnapshot(destinationRoot: string): Promise<ViewSnapshot> {
  await mkdir(destinationRoot, { recursive: true })
  const source = await mkdtemp(join(destinationRoot, ".empty-source-"))
  try {
    await writeFile(join(source, "view.json"), `${JSON.stringify({ version: 1, id: "empty" }, null, 2)}\n`)
    return await snapshotViewDirectory(source, destinationRoot)
  } finally {
    await rm(source, { recursive: true, force: true })
  }
}
