import { DiffRenderable, TextRenderable } from "@opentui/core"
import type { OverlayManager } from "./overlay-manager.ts"
import { systemColors } from "./theme.ts"

export type PermissionDiffViewerOptions = {
  id: string
  title: string
  patch?: string
  error?: string
  signal?: AbortSignal
}

/** 使用 OpenTUI DiffRenderable 展示带行号和颜色的 unified diff。 */
export function showPermissionDiff(overlays: OverlayManager, options: PermissionDiffViewerOptions): Promise<void> {
  return new Promise((resolve) => {
    const pageSize = 16
    let offset = 0
    let settled = false
    const lineCount = Math.max(1, options.patch?.split("\n").length ?? options.error?.split("\n").length ?? 1)
    const handle = overlays.open({
      id: options.id,
      title: options.title,
      description: options.error ? "无法生成可靠 diff；请检查失败原因和替换参数" : "标准 unified diff 预览",
      contentHeight: pageSize,
      actions: [],
      ...(options.signal ? { signal: options.signal } : {}),
      onCancel: () => finish(),
    })
    const content = options.error
      ? new TextRenderable(overlays.renderer, {
          id: `${options.id}-error-content`,
          position: "absolute",
          width: "100%",
          height: "100%",
          wrapMode: "word",
          fg: systemColors.error,
          content: options.error,
        })
      : new DiffRenderable(overlays.renderer, {
          id: `${options.id}-diff`,
          position: "absolute",
          width: "100%",
          height: "100%",
          diff: options.patch ?? "",
          view: "unified",
          wrapMode: "none",
          showLineNumbers: true,
          addedBg: systemColors.successBg,
          removedBg: systemColors.errorBg,
          contextBg: systemColors.bgOverlay,
          addedSignColor: systemColors.success,
          removedSignColor: systemColors.error,
        })
    handle.content.add(content)
    const render = () => {
      offset = Math.max(0, Math.min(offset, Math.max(0, lineCount - pageSize)))
      content.top = -offset
      content.height = Math.max(pageSize, lineCount)
      handle.setDescription(
        options.error
          ? "无法生成可靠 diff；请检查失败原因和替换参数"
          : `diff 行 ${Math.min(offset + 1, lineCount)}-${Math.min(offset + pageSize, lineCount)} / ${lineCount}`,
      )
    }
    const finish = () => {
      if (settled) return
      settled = true
      handle.close()
      resolve()
    }
    handle.setActions([
      {
        id: "line",
        key: { name: "up" },
        alternateKeys: [{ name: "down" }],
        label: "↑↓ 逐行",
        run: (key) => {
          offset += key.name === "up" ? -1 : 1
          render()
        },
      },
      {
        id: "page",
        key: { name: "pageup" },
        alternateKeys: [{ name: "pagedown" }],
        label: "PgUp/PgDn 翻页",
        run: (key) => {
          offset += key.name === "pageup" ? -pageSize : pageSize
          render()
        },
      },
      { id: "return", key: { name: "return" }, label: "Enter 返回", run: finish },
      { id: "cancel", key: { name: "escape" }, label: "Esc 返回", run: finish },
    ])
    render()
  })
}
