import { type CliRenderer, CliRenderEvents, createCliRenderer } from "@opentui/core"

/** tui-kit 对业务层暴露的渲染器类型，避免业务代码直接依赖 OpenTUI。 */
export type TuiRenderer = CliRenderer

/** 默认 footer 高度：终端视口信息就绪前的占位值。 */
const DEFAULT_FOOTER_HEIGHT = 9

/**
 * 根据终端行数计算 footer 固定高度。
 *
 * 规则：目标取 min(12, h/2)，下限 9（保证固定行 + 输入区 1 行 + 输出区 3 行的最小空间），
 * 上限 h-2（保证历史滚动区至少保留 2 行）。
 *
 * footer 高度只随终端视口变化，内容变化绝不调整——内容驱动的 footerHeight 变化会
 * 触发 RESIZE 事件并导致聊天历史被清除后完整重绘，是卡顿的重要来源。
 */
export function computeFooterHeight(terminalHeight: number): number {
  if (terminalHeight <= 0) return DEFAULT_FOOTER_HEIGHT
  const target = Math.min(12, Math.floor(terminalHeight / 2))
  return Math.min(Math.max(target, DEFAULT_FOOTER_HEIGHT), terminalHeight - 2)
}

export async function createAizenRenderer(): Promise<CliRenderer> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "split-footer",
    footerHeight: DEFAULT_FOOTER_HEIGHT,
    externalOutputMode: "capture-stdout",
    useMouse: false,
  })
  // footer 高度按视口行数校准。仅在终端行数真正变化时重算（此时历史全量重绘
  // 本就在预期内）；OverlayManager 为 overlay 临时调整 footerHeight 也会触发
  // RESIZE 事件，但终端尺寸未变，必须跳过以免覆盖 overlay 的临时高度。
  let lastTerminalHeight = -1
  const syncFooterHeight = () => {
    if (renderer.isDestroyed) return
    const terminalHeight = renderer.terminalHeight
    if (terminalHeight === lastTerminalHeight) return
    lastTerminalHeight = terminalHeight
    const next = computeFooterHeight(terminalHeight)
    if (next !== renderer.footerHeight) renderer.footerHeight = next
  }
  syncFooterHeight()
  renderer.on(CliRenderEvents.RESIZE, syncFooterHeight)
  renderer.once(CliRenderEvents.DESTROY, () => renderer.off(CliRenderEvents.RESIZE, syncFooterHeight))
  return renderer
}

function safeTerminalTitle(title: string): string {
  return Array.from(title)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 31 && (codePoint < 127 || codePoint > 159)
    })
    .slice(0, 120)
    .join("")
    .trim()
}

/** 设置经过控制字符过滤和长度限制的终端标题。 */
export function setAizenTerminalTitle(renderer: CliRenderer, title: string): void {
  renderer.setTerminalTitle(safeTerminalTitle(title) || "AizenAssistant")
}

export function destroyRenderer(renderer: CliRenderer): void {
  renderer.destroy()
}
