import { type BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core"

export type ScrollableTextState = {
  firstLine: number
  lastLine: number
  totalLines: number
  viewportLines: number
  atEnd: boolean
}

export type ScrollableTextViewOptions = {
  id: string
  parent: BoxRenderable
  content: string
  wrapMode?: "word" | "char"
  fg?: string
  onStateChange?: (state: ScrollableTextState) => void
  onViewedToEnd?: () => void
}

export type ScrollableTextView = {
  readonly renderable: TextRenderable
  /** 按自动换行后的视觉行滚动指定距离。 */
  scrollBy(lines: number): void
  /** 按当前可见高度向上或向下滚动一页。 */
  scrollPage(direction: -1 | 1): void
  /** 读取并通知当前滚动状态。 */
  refresh(): ScrollableTextState
  /** 注销 resize 监听；父容器负责销毁渲染对象。 */
  dispose(): void
}

/**
 * 创建使用 OpenTUI 自动换行结果的可滚动文本视图。
 * 组件不自行拆行；终端 resize 后由 TextRenderable 重新排版，并据其实际视觉行数校正滚动位置。
 */
export function createScrollableTextView(
  renderer: CliRenderer,
  options: ScrollableTextViewOptions,
): ScrollableTextView {
  const renderable = new TextRenderable(renderer, {
    id: options.id,
    position: "absolute",
    width: "100%",
    height: "100%",
    wrapMode: options.wrapMode ?? "word",
    ...(options.fg ? { fg: options.fg } : {}),
    content: options.content,
  })
  options.parent.add(renderable)

  let disposed = false
  let viewedToEnd = false
  let lastState: ScrollableTextState | undefined

  const state = (): ScrollableTextState => {
    const totalLines = Math.max(1, renderable.virtualLineCount || renderable.lineCount || 1)
    const viewportLines = Math.max(1, renderable.height || options.parent.height || 1)
    const maximum = Math.max(0, renderable.maxScrollY)
    const scrollY = Math.max(0, Math.min(renderable.scrollY, maximum))
    if (scrollY !== renderable.scrollY) renderable.scrollY = scrollY
    return {
      firstLine: Math.min(totalLines, scrollY + 1),
      lastLine: Math.min(totalLines, scrollY + viewportLines),
      totalLines,
      viewportLines,
      atEnd: maximum === 0 || scrollY >= maximum,
    }
  }

  const refresh = (): ScrollableTextState => {
    const current = state()
    lastState = current
    options.onStateChange?.(current)
    if (current.atEnd && !viewedToEnd) {
      viewedToEnd = true
      options.onViewedToEnd?.()
    }
    return current
  }

  const onLineInfoChange = () => {
    if (disposed || renderable.isDestroyed) return
    const keepAtEnd = lastState?.atEnd ?? false
    if (keepAtEnd) renderable.scrollY = renderable.maxScrollY
    else if (renderable.scrollY > renderable.maxScrollY) renderable.scrollY = renderable.maxScrollY
    refresh()
  }
  renderable.on("line-info-change", onLineInfoChange)

  const view: ScrollableTextView = {
    renderable,
    scrollBy(lines) {
      if (disposed || renderable.isDestroyed) return
      renderable.scrollY = Math.max(0, Math.min(renderable.maxScrollY, renderable.scrollY + lines))
      refresh()
    },
    scrollPage(direction) {
      const viewportLines = Math.max(1, lastState?.viewportLines ?? renderable.height ?? 1)
      view.scrollBy(direction * viewportLines)
    },
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      renderable.off("line-info-change", onLineInfoChange)
    },
  }

  return view
}
