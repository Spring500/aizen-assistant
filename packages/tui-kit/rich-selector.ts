import {
  type CliRenderer,
  createTextAttributes,
  parseColor,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"
import { systemColors } from "./theme.ts"

export type RichSegment = {
  text: string
  color?: string
  bold?: boolean
  italic?: boolean
  dim?: boolean
}

export type RichSelectorItem<T> = {
  segments: RichSegment[]
  details?: RichSegment[]
  value: T
}

function content(item: RichSelectorItem<unknown>, selected: boolean, details = false): StyledText {
  const chunks: TextChunk[] = [
    {
      __isChunk: true,
      text: details ? "  " : selected ? "▶ " : "  ",
      fg: parseColor(selected ? systemColors.header : systemColors.secondary),
    },
  ]
  for (const segment of details ? (item.details ?? []) : item.segments) {
    chunks.push({
      __isChunk: true,
      text: segment.text,
      fg: parseColor(segment.color ?? (selected ? systemColors.header : systemColors.secondary)),
      attributes: createTextAttributes({
        ...(segment.bold === undefined ? {} : { bold: segment.bold }),
        ...(segment.italic === undefined ? {} : { italic: segment.italic }),
        ...(segment.dim === undefined ? {} : { dim: segment.dim }),
      }),
    })
  }
  return new StyledText(chunks)
}

export function selectRichItem<T>(
  manager: OverlayManager | CliRenderer,
  id: string,
  items: RichSelectorItem<T>[],
  options: { title: string; signal?: AbortSignal },
): Promise<T | undefined> {
  const overlays = overlayManager(manager)
  return new Promise((resolve) => {
    let settled = false
    let selected = 0
    const rowHeight = items.some((item) => item.details) ? 2 : 1
    const visibleItems = Math.max(1, Math.min(items.length, rowHeight === 2 ? 5 : 10))
    const handle = overlays.open<T>({
      id,
      title: options.title,
      help: "↑↓ 移动 | Enter 选择 | Esc 返回",
      contentHeight: visibleItems * rowHeight,
      ...(options.signal ? { signal: options.signal } : {}),
      onCancel: () => finish(undefined, true),
    })
    const rows = Array.from(
      { length: visibleItems * rowHeight },
      (_, index) =>
        new TextRenderable(overlays.renderer, {
          id: `${id}-${index}`,
          position: "absolute",
          top: index,
          left: 0,
          right: 0,
          height: 1,
          wrapMode: "none",
          truncate: true,
          content: "",
        }),
    )
    for (const row of rows) handle.content.add(row)

    const render = () => {
      const maxOffset = Math.max(0, items.length - visibleItems)
      const offset = Math.min(maxOffset, Math.max(0, selected - visibleItems + 1))
      for (const [rowIndex, row] of rows.entries()) {
        const itemIndex = offset + Math.floor(rowIndex / rowHeight)
        const item = items[itemIndex]
        const detailRow = rowHeight === 2 && rowIndex % rowHeight === 1
        row.visible = item !== undefined
        if (item) row.content = content(item, itemIndex === selected, detailRow)
      }
    }
    const finish = (value: T | undefined, cancelled = false) => {
      if (settled) return
      settled = true
      handle.close(value)
      resolve(cancelled ? undefined : value)
    }
    handle.setInput({
      keypress: (key) => {
        if (key.name === "up") {
          selected = Math.max(0, selected - 1)
          render()
        } else if (key.name === "down") {
          selected = Math.min(items.length - 1, selected + 1)
          render()
        } else if (key.name === "return") finish(items[selected]?.value)
        else if (key.name === "escape") finish(undefined)
      },
    })
    render()
  })
}
