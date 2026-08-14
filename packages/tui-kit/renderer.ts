import { type CliRenderer, CliRenderEvents, createCliRenderer, type ThemeMode } from "@opentui/core"
import { MIN_FOOTER_HEIGHT } from "./footer-layout.ts"
import { setSystemColors, type ColorMode } from "./theme.ts"

/** tui-kit 对业务层暴露的渲染器类型，避免业务代码直接依赖 OpenTUI。 */
export type TuiRenderer = CliRenderer

/**
 * 根据终端行数计算 footer 高度。
 *
 * 目标为视口行数的一半（随视口增长、无上限）；下限为最小可行高度 9。
 * 上限 h-2 仅为防御：保证滚动区至少保留 2 行（正常视口下 h/2 恒小于 h-2）。
 *
 * footer 高度只随终端视口变化，内容变化绝不调整——内容驱动的 footerHeight 变化会
 * 触发 RESIZE 事件并导致聊天历史被清除后完整重绘，是卡顿的重要来源。
 */
export function computeFooterHeight(terminalHeight: number): number {
  if (terminalHeight <= 0) return MIN_FOOTER_HEIGHT
  return Math.max(MIN_FOOTER_HEIGHT, Math.min(Math.floor(terminalHeight / 2), terminalHeight - 2))
}

export async function createAizenRenderer(): Promise<CliRenderer> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "split-footer",
    // 终端视口信息就绪前的占位高度 = footer 最小可行高度。
    footerHeight: MIN_FOOTER_HEIGHT,
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

/**
 * 同步 TUI 色板与终端配色：应用初始 themeMode，并订阅运行中切换。
 *
 * 切换发生（亮暗翻转）时先更新 systemColors，再回调 onThemeChanged，
 * 由调用方负责刷新已渲染内容（历史全量重放与 footer）。
 * 终端不支持配色检测或测试渲染器下 themeMode 为 null，保持默认深色色板。
 * 返回取消订阅函数，供销毁时调用。
 */
export function initThemeSync(renderer: CliRenderer, onThemeChanged: (mode: ColorMode) => void): () => void {
  const apply = (mode: ThemeMode | null) => {
    if (!mode) return
    if (setSystemColors(mode)) onThemeChanged(mode)
  }
  // 初始 themeMode 可能因异步查询尚未就绪，等待一次结果；此后由事件驱动。
  if (renderer.themeMode) apply(renderer.themeMode)
  else
    void renderer
      .waitForThemeMode(300)
      .then((mode) => apply(mode))
      .catch(() => {})
  const listener = (mode: ThemeMode) => apply(mode)
  renderer.on(CliRenderEvents.THEME_MODE, listener)
  return () => renderer.off(CliRenderEvents.THEME_MODE, listener)
}
