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
 * 向终端发送原始查询序列（如 CSI ?997n 配色模式查询）。
 *
 * capture-stdout 模式下 process.stdout.write 会被 OpenTUI 拦截并渲染到输出区，
 * 必须使用 renderer 持有的原始 stdout 引用直达终端；发送失败（如测试渲染器）
 * 时静默忽略，交由调用方兜底。
 */
function sendTerminalQuery(renderer: CliRenderer, sequence: string): void {
  const self = renderer as unknown as {
    stdout?: NodeJS.WriteStream
    realStdoutWrite?: (chunk: unknown, encoding?: unknown, callback?: unknown) => void
  }
  try {
    if (typeof self.realStdoutWrite === "function" && self.stdout) {
      self.realStdoutWrite.call(self.stdout, sequence)
    } else {
      process.stdout.write(sequence)
    }
  } catch {
    // 发送失败（如测试渲染器的 stdout 引用失效）时静默忽略。
  }
}

/**
 * 同步 TUI 色板与终端配色，并在运行中跟随切换。
 *
 * 主动发送 Kitty CSI ?997n 配色模式查询，让 OpenTUI 内部链路（收到 997 响应后
 * 查询 OSC 10/11 背景色）激活并更新 themeMode；亮暗翻转经 THEME_MODE 事件
 * 驱动切换。终端不支持该查询时保持默认深色色板。
 *
 * 切换发生（亮暗翻转）时先更新 systemColors，再回调 onThemeChanged，
 * 由调用方负责刷新已渲染内容（历史全量重放与 footer）。
 * 返回取消订阅函数，供销毁时调用。
 */
export function initThemeSync(renderer: CliRenderer, onThemeChanged: (mode: ColorMode) => void): () => void {
  const apply = (mode: ThemeMode | null | undefined) => {
    if (!mode) return
    if (setSystemColors(mode)) onThemeChanged(mode)
  }
  // 立即应用已就绪的 themeMode（终端支持时启动即可得）。
  apply(renderer.themeMode)
  // 主动查询终端配色模式，激活 OpenTUI 的 themeMode 链路。
  sendTerminalQuery(renderer, "\x1b[?997n")
  // 运行中亮暗翻转由事件驱动切换。
  const listener = (mode: ThemeMode) => apply(mode)
  renderer.on(CliRenderEvents.THEME_MODE, listener)
  return () => renderer.off(CliRenderEvents.THEME_MODE, listener)
}
