import {
  type CliRenderer,
  createTextAttributes,
  type KeyEvent,
  parseColor,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
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
  value: T
}

function content(item: RichSelectorItem<unknown>, selected: boolean): StyledText {
  const chunks: TextChunk[] = [
    {
      __isChunk: true,
      text: selected ? "▶ " : "  ",
      fg: parseColor(selected ? systemColors.header : systemColors.secondary),
    },
  ]
  for (const segment of item.segments) {
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
  renderer: CliRenderer,
  id: string,
  items: RichSelectorItem<T>[],
  options: { title: string; signal?: AbortSignal },
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const previousFooterHeight = renderer.footerHeight
    if (renderer.screenMode === "split-footer") renderer.footerHeight = Math.max(previousFooterHeight, 12)
    const title = new TextRenderable(renderer, {
      id: `${id}-title`,
      position: "absolute",
      top: 1,
      left: 1,
      right: 0,
      height: 1,
      zIndex: 121,
      fg: systemColors.header,
      content: options.title,
    })
    let selected = 0
    const rows = items.map(
      (item, index) =>
        new TextRenderable(renderer, {
          id: `${id}-${index}`,
          position: "absolute",
          top: 3 + index,
          left: 1,
          right: 0,
          height: 1,
          zIndex: 120,
          content: content(item, index === selected),
        }),
    )
    renderer.root.add(title)
    for (const row of rows) renderer.root.add(row)
    let settled = false
    const render = () => {
      for (const [index, row] of rows.entries()) {
        const item = items[index]
        if (item) row.content = content(item, index === selected)
      }
    }
    const finish = (value: T | undefined) => {
      if (settled) return
      settled = true
      renderer.keyInput.off("keypress", onKeyPress)
      options.signal?.removeEventListener("abort", onAbort)
      for (const row of rows) row.destroy()
      title.destroy()
      renderer.footerHeight = previousFooterHeight
      resolve(value)
    }
    const onKeyPress = (key: KeyEvent) => {
      if (key.name === "up") {
        selected = Math.max(0, selected - 1)
        render()
      } else if (key.name === "down") {
        selected = Math.min(items.length - 1, selected + 1)
        render()
      } else if (key.name === "return") finish(items[selected]?.value)
      else if (key.name === "escape") finish(undefined)
    }
    const onAbort = () => finish(undefined)
    renderer.keyInput.on("keypress", onKeyPress)
    if (options.signal?.aborted) finish(undefined)
    else options.signal?.addEventListener("abort", onAbort, { once: true })
  })
}
