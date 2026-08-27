/**
 * footer 布局常量：editor、output-panel、renderer 三方共用，单一来源。
 *
 * 布局自上而下：输出区（含命令补全，最小 MIN_OUTPUT_ROWS 行）→ 输入区（最小
 * MIN_INPUT_ROWS 行）→ 第一条分割线 → 第二条分割线 → 信息行 → 快捷键提示行
 * → 错误提示行（后五项为固定行）。
 */

/** footer 固定行：第一条分割线 + 第二条分割线 + 信息行 + 快捷键提示行 + 错误提示行。 */
export const FOOTER_FIXED_ROWS = 5

/** 输出区最小行数：即流式输出保底行数，工具行再多也不少于该行数。 */
export const MIN_OUTPUT_ROWS = 3

/** 输入区最小行数。 */
export const MIN_INPUT_ROWS = 1

/** footer 最小可行高度：固定行 + 输入区最小 1 行 + 输出区保底（矮终端隐藏快捷键行时）。 */
export const MIN_FOOTER_HEIGHT = FOOTER_FIXED_ROWS + MIN_INPUT_ROWS + MIN_OUTPUT_ROWS

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
