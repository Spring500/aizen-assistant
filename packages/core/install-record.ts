import { readFile, writeFile, mkdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

/** 安装来源通道：github（安装脚本安装）或 npm（launcher 管理，预留）。 */
export type InstallChannel = "github" | "npm"

/** install.json 的内容：安装来源记录，供 update / uninstall 判断行为。全部字段由安装方写入，可抛弃重建。 */
export type InstallRecord = {
  channel: InstallChannel
  version: string
  platform: string
  /** 当前激活的版本目录名（多版本布局下为 versions/ 下的子目录名，如 v0.2.0）。旧记录无此字段时以 version 兜底。 */
  current: string
}

/**
 * install.json 位置：受管安装为 <安装根>/install.json。
 * 真身可能在两种布局下运行：多版本布局 <根>/versions/<current>/exe，或旧单文件布局 <根>/bin/exe；
 * 便携拷贝（exe 旁无 install.json）视为未受管。
 */
export function installRecordPath(): string {
  const exeDir = dirname(process.execPath)
  const root = basename(dirname(exeDir)) === "versions" ? dirname(dirname(exeDir)) : dirname(exeDir)
  return join(root, "install.json")
}

/** 读取 install.json；文件不存在或内容无效时返回 undefined（视为未受管）。 */
export async function readInstallRecord(file: string = installRecordPath()): Promise<InstallRecord | undefined> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
  try {
    const parsed = JSON.parse(text) as Partial<InstallRecord>
    if (parsed.channel !== "github" && parsed.channel !== "npm") return undefined
    if (typeof parsed.version !== "string" || typeof parsed.platform !== "string") return undefined
    // 旧版单文件布局的 install.json 没有 current 字段；读取时以 version 兜底，保证多版本机制启用前的记录可读。
    return {
      channel: parsed.channel,
      version: parsed.version,
      platform: parsed.platform,
      current: typeof parsed.current === "string" && parsed.current.length > 0 ? parsed.current : parsed.version,
    }
  } catch {
    return undefined
  }
}

/** 写入 install.json（自动创建父目录）；不传路径时写入默认安装位置。 */
export async function writeInstallRecord(record: InstallRecord, file: string = installRecordPath()): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
}
