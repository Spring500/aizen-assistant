/**
 * 生成 VitePress 侧边栏配置脚本。
 *
 * 扫描 docs/zh 目录下全部 .md 文件（排除 .vitepress/），读取每篇文档 frontmatter 中的
 * title / type / sort 字段，按读者分组生成侧边栏结构，输出到
 * docs/.vitepress/sidebar.generated.ts，供 config.ts 引用。
 *
 * 分组规则：
 * - type: guide     -> "用户指南"
 * - type: spec      -> "开发者文档"
 * - type: reference -> "参考"
 *
 * 组内按 sort 字段排序（缺省 0），同 sort 按链接稳定排序。
 * 未标注 frontmatter 的 md 文件会被跳过并在 stderr 输出警告。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { parse as parseYaml } from "yaml"

const DOCS_ROOT = join(import.meta.dir, "..", "docs", "zh")
const OUT_FILE = join(import.meta.dir, "..", "docs", ".vitepress", "sidebar.generated.ts")

type DocType = "guide" | "spec" | "reference"

interface DocMeta {
  title: string
  type: DocType
  sort: number
}

const GROUP_LABEL: Record<DocType, string> = {
  guide: "用户指南",
  spec: "开发者文档",
  reference: "参考",
}

const TYPE_ORDER: DocType[] = ["guide", "reference", "spec"]

/** 递归收集目录下所有 .md 文件绝对路径 */
function collectMarkdown(dir: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === ".vitepress") continue
      result.push(...collectMarkdown(full))
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      result.push(full)
    }
  }
  return result
}

/** 解析 frontmatter；无 frontmatter 返回 null */
function parseMeta(file: string): DocMeta | null {
  const content = readFileSync(file, "utf-8")
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match?.[1]) return null
  const raw = parseYaml(match[1]) as Record<string, unknown>
  const type = raw.type
  if (type !== "guide" && type !== "spec" && type !== "reference") {
    throw new Error(`无效的 type 字段: ${file} -> ${String(type)}`)
  }
  const title = typeof raw.title === "string" && raw.title.length > 0 ? raw.title : basename(file)
  const sort = typeof raw.sort === "number" ? raw.sort : 0
  return { title, type, sort }
}

/** 从文件绝对路径推导站内链接 */
function linkFrom(file: string): string {
  const rel = relative(DOCS_ROOT, file).replace(/\\/g, "/")
  return `/zh/${rel.replace(/\.md$/, "")}`
}

const docs: { meta: DocMeta; link: string }[] = []
for (const file of collectMarkdown(DOCS_ROOT)) {
  // 首页 index.md 不进入侧边栏
  if (basename(file) === "index.md") continue
  const meta = parseMeta(file)
  if (!meta) {
    console.warn(`[gen-sidebar] 跳过无 frontmatter 的文档: ${relative(DOCS_ROOT, file)}`)
    continue
  }
  docs.push({ meta, link: linkFrom(file) })
}

// 按 type 分组，组内按 sort、再按链接稳定排序
const groups = TYPE_ORDER.flatMap((type) => {
  const items = docs
    .filter((d) => d.meta.type === type)
    .sort((a, b) => a.meta.sort - b.meta.sort || a.link.localeCompare(b.link))
    .map((d) => ({ text: d.meta.title, link: d.link }))
  return items.length > 0 ? [{ text: GROUP_LABEL[type], items }] : []
})

const lines: string[] = [
  "// 本文件由 scripts/gen-sidebar.ts 自动生成，请勿手工编辑。",
  'import type { DefaultTheme } from "vitepress"',
  "",
  "export const sidebar: DefaultTheme.Sidebar = {",
  '  "/zh/": [',
]
for (const group of groups) {
  lines.push("    {")
  lines.push(`      text: ${JSON.stringify(group.text)},`)
  lines.push("      items: [")
  for (const item of group.items) {
    lines.push("        {")
    lines.push(`          text: ${JSON.stringify(item.text)},`)
    lines.push(`          link: ${JSON.stringify(item.link)}`)
    lines.push("        },")
  }
  lines.push("      ],")
  lines.push("    },")
}
lines.push("  ],")
lines.push("}")

writeFileSync(OUT_FILE, `${lines.join("\n")}\n`)
console.log(`[gen-sidebar] 已生成 ${relative(join(import.meta.dir, ".."), OUT_FILE)}（${docs.length} 篇文档）`)
