import type { ContextReport } from "../core/types.ts"
import type { OverlayManager } from "./overlay-manager.ts"
import { createScrollableTextView } from "./scrollable-text-view.ts"
import { systemColors } from "./theme.ts"

/**
 * 把运行时上下文报告渲染为分章节的纯文本：
 * 系统提示词、下一条消息注入的上下文、当前激活工具的参数 Schema。
 * 纯函数，不依赖任何渲染器，便于离屏测试。
 */
export function contextReportText(report: ContextReport): string {
  const lines: string[] = []
  lines.push("【系统提示词】")
  lines.push(report.systemPrompt || "（无）")
  lines.push("")
  lines.push("【下一条消息注入的上下文】")
  if (report.injectedItems.length === 0) {
    lines.push("（无）")
  } else {
    for (const item of report.injectedItems) {
      const text = item.parts
        .filter((part) => part.kind === "text")
        .map((part) => part.text)
        .join("\n")
      lines.push(`[${item.source}] ${text}`)
    }
  }
  lines.push("")
  const active = new Set(report.activeToolNames)
  const activeTools = report.tools.filter((tool) => active.has(tool.name))
  const inactive = report.tools.filter((tool) => !active.has(tool.name))
  lines.push(`【工具 Schema（当前激活 ${activeTools.length} 个）】`)
  for (const tool of activeTools) {
    lines.push("")
    lines.push(`## ${tool.name}`)
    if (tool.description) lines.push(tool.description)
    lines.push(JSON.stringify(tool.parameters, null, 2))
  }
  if (inactive.length > 0) {
    lines.push("")
    lines.push(`未激活工具：${inactive.map((tool) => tool.name).join("、")}`)
  }
  return lines.join("\n")
}

/**
 * 打开只读、可滚动、分章节展示运行时上下文的浮窗；Enter/Esc 关闭。
 * 数据已由 core 现场读取，这里只负责渲染，不再访问运行时。
 */
export async function showContextReport(
  overlays: OverlayManager,
  report: ContextReport,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    const pageSize = 24
    const handle = overlays.open({
      id: "context-report",
      title: "运行时上下文",
      description: "内容按终端宽度自动换行；↑↓ 逐行、PgUp/PgDn 翻页",
      contentHeight: pageSize,
      actions: [],
      ...(signal ? { signal } : {}),
      onCancel: () => finish(),
    })
    const text = createScrollableTextView(overlays.renderer, {
      id: "context-report-content",
      parent: handle.content,
      content: contextReportText(report),
      wrapMode: "word",
      fg: systemColors.secondary,
      onStateChange: (state) =>
        handle.setDescription(`视觉行 ${state.firstLine}-${state.lastLine} / ${state.totalLines}`),
    })
    const finish = () => {
      if (settled) return
      settled = true
      text.dispose()
      handle.close()
      resolve()
    }
    handle.setActions([
      {
        id: "line",
        key: { name: "up" },
        alternateKeys: [{ name: "down" }],
        label: "↑↓ 逐行",
        run: (key) => text.scrollBy(key.name === "up" ? -1 : 1),
      },
      {
        id: "page",
        key: { name: "pageup" },
        alternateKeys: [{ name: "pagedown" }],
        label: "PgUp/PgDn 翻页",
        run: (key) => text.scrollPage(key.name === "pageup" ? -1 : 1),
      },
      { id: "return", key: { name: "return" }, label: "Enter 返回", run: finish },
      { id: "cancel", key: { name: "escape" }, label: "Esc 返回", run: finish },
    ])
    text.refresh()
  })
}
