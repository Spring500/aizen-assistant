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
