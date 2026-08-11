import { homedir } from "node:os"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

/** 安装来源通道：github（安装脚本安装）或 npm（launcher 管理，预留）。 */
export type InstallChannel = "github" | "npm"

/** install.json 的内容：安装来源记录，供 update / uninstall 判断行为。全部字段由安装方写入，可抛弃重建。 */
export type InstallRecord = {
  channel: InstallChannel
  version: string
  platform: string
}

/** 受管安装的 install.json 固定路径（~/.aizen/install.json）。便携拷贝场景下该文件不存在。 */
export function installRecordPath(): string {
  return join(homedir(), ".aizen", "install.json")
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
    return { channel: parsed.channel, version: parsed.version, platform: parsed.platform }
  } catch {
    return undefined
  }
}

/** 写入 install.json（自动创建父目录）；不传路径时写入默认安装位置。 */
export async function writeInstallRecord(record: InstallRecord, file: string = installRecordPath()): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
}
