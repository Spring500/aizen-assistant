/**
 * AizenAssistant TUI 统一颜色表。
 *
 * 所有 TUI 渲染颜色必须从本表取色，禁止在组件内硬编码十六进制色值。
 * 提供深色/浅色两套取值，按终端配色（OpenTUI themeMode）自动切换：
 * - 组件渲染时通过 systemColors 取色，切换色板后重新渲染即用新值；
 * - 聊天转录、footer 等已渲染内容的刷新由调用方（interactive-app）触发全量重放。
 */

/** 深色终端色板。 */
export const darkThemeColors = {
  // ── 文字色 ─────────────────────────────────────────
  /** 主文字：正文、代码默认文字、编辑器输入。 */
  text: "#f3f4f6",
  /** 强调：标题、链接、内联代码、选中项、会话名、模型名等。 */
  accent: "#a78bfa",
  /** 成功/空闲状态。 */
  success: "#22c55e",
  /** 警告/运行中状态。 */
  warning: "#facc15",
  /** 错误状态。 */
  error: "#f87171",
  /** 黯淡文字：次级信息、快捷键、描述、注释、禁用项、占位符。 */
  dim: "#9ca3af",

  // ── 背景色 ─────────────────────────────────────────
  /** 默认背景：普通消息、思考块、diff 上下文行。 */
  bgDefault: "#252936",
  /** 用户消息背景。 */
  bgUser: "#66551a",
  /** 助手消息背景。 */
  bgAssistant: "#1f2937",
  /** 工具块与代码块背景。 */
  bgTool: "#292c31",
  /** 浮层背景：选择器、输入框、overlay。 */
  bgOverlay: "#111827",
  /** 黯淡背景：弱化场景（禁用态、遮罩）。 */
  bgDim: "#1b1f2b",
  /** 成功态背景：diff 新增行。 */
  successBg: "#123524",
  /** 错误态背景：diff 删除行。 */
  errorBg: "#3f1d24",

  // ── 语法高亮 ───────────────────────────────────────
  /** 关键字。 */
  syntaxKeyword: "#f472b6",
  /** 字符串。 */
  syntaxString: "#86efac",
  /** 数字与布尔值。 */
  syntaxNumber: "#facc15",
  /** 类型。 */
  syntaxType: "#60a5fa",
  /** 函数。 */
  syntaxFunction: "#c4b5fd",
  /** 属性与成员。 */
  syntaxProperty: "#67e8f9",
  /** 内建变量。 */
  syntaxVariable: "#fb923c",
  /** 运算符。 */
  syntaxOperator: "#f9a8d4",

  // ── markdown 语法 ─────────────────────────────────
  /** markdown 一级标题。 */
  mdHeading1: "#f472b6",
  /** markdown 二级标题。 */
  mdHeading2: "#22d3ee",
  /** markdown 三级标题。 */
  mdHeading3: "#a78bfa",
  /** markdown 四级标题。 */
  mdHeading4: "#c4b5fd",
  /** markdown 五级标题。 */
  mdHeading5: "#d8b4fe",
  /** markdown 六级标题。 */
  mdHeading6: "#e9d5ff",
  /** markdown 内联代码（`code`）。 */
  mdInlineCode: "#fb923c",
  /** markdown 链接文本。 */
  mdLink: "#22d3ee",
  /** markdown 链接地址。 */
  mdLinkUrl: "#9ca3af",
  /** markdown 引用。 */
  mdQuote: "#9ca3af",
  /** markdown 列表标记。 */
  mdListBullet: "#a78bfa",
  /** markdown 特殊标点。 */
  mdPunctuation: "#9ca3af",
  /** markdown 公式（行内与块级）。 */
  mdFormula: "#facc15",
  /** markdown 代码块内未命中规则的默认文字。 */
  mdCodeBlock: "#d1d5db",
} as const

/** 浅色终端色板。 */
export const lightThemeColors = {
  // ── 文字色 ─────────────────────────────────────────
  /** 主文字：正文、代码默认文字、编辑器输入。 */
  text: "#1f2937",
  /** 强调：标题、链接、内联代码、选中项、会话名、模型名等。 */
  accent: "#7c3aed",
  /** 成功/空闲状态。 */
  success: "#15803d",
  /** 警告/运行中状态。 */
  warning: "#a16207",
  /** 错误状态。 */
  error: "#b91c1c",
  /** 黯淡文字：次级信息、快捷键、描述、注释、禁用项、占位符。 */
  dim: "#6b7280",

  // ── 背景色 ─────────────────────────────────────────
  /** 默认背景：普通消息、思考块、diff 上下文行。 */
  bgDefault: "#f3f4f6",
  /** 用户消息背景。 */
  bgUser: "#fef3c7",
  /** 助手消息背景。 */
  bgAssistant: "#f9fafb",
  /** 工具块与代码块背景。 */
  bgTool: "#e5e7eb",
  /** 浮层背景：选择器、输入框、overlay。 */
  bgOverlay: "#ffffff",
  /** 黯淡背景：弱化场景（禁用态、遮罩）。 */
  bgDim: "#e5e7eb",
  /** 成功态背景：diff 新增行。 */
  successBg: "#dcfce7",
  /** 错误态背景：diff 删除行。 */
  errorBg: "#fee2e2",

  // ── 语法高亮 ───────────────────────────────────────
  /** 关键字。 */
  syntaxKeyword: "#be185d",
  /** 字符串。 */
  syntaxString: "#047857",
  /** 数字与布尔值。 */
  syntaxNumber: "#b45309",
  /** 类型。 */
  syntaxType: "#1d4ed8",
  /** 函数。 */
  syntaxFunction: "#9333ea",
  /** 属性与成员。 */
  syntaxProperty: "#0e7490",
  /** 内建变量。 */
  syntaxVariable: "#c2410c",
  /** 运算符。 */
  syntaxOperator: "#9d174d",

  // ── markdown 语法 ─────────────────────────────────
  /** markdown 一级标题。 */
  mdHeading1: "#be185d",
  /** markdown 二级标题。 */
  mdHeading2: "#0e7490",
  /** markdown 三级标题。 */
  mdHeading3: "#7c3aed",
  /** markdown 四级标题。 */
  mdHeading4: "#9333ea",
  /** markdown 五级标题。 */
  mdHeading5: "#a855f7",
  /** markdown 六级标题。 */
  mdHeading6: "#c084fc",
  /** markdown 内联代码（`code`）。 */
  mdInlineCode: "#c2410c",
  /** markdown 链接文本。 */
  mdLink: "#0e7490",
  /** markdown 链接地址。 */
  mdLinkUrl: "#6b7280",
  /** markdown 引用。 */
  mdQuote: "#6b7280",
  /** markdown 列表标记。 */
  mdListBullet: "#7c3aed",
  /** markdown 特殊标点。 */
  mdPunctuation: "#6b7280",
  /** markdown 公式（行内与块级）。 */
  mdFormula: "#b45309",
  /** markdown 代码块内未命中规则的默认文字。 */
  mdCodeBlock: "#4b5563",
} as const

/** 终端配色模式：深色或浅色。 */
export type ColorMode = "dark" | "light"

/** 当前生效的色板（按终端配色由 setSystemColors 切换，默认深色）。 */
export let systemColors: typeof darkThemeColors | typeof lightThemeColors = darkThemeColors

/**
 * 按终端配色模式切换当前色板。
 * 返回是否发生了切换；模式与当前色板一致时返回 false。
 */
export function setSystemColors(mode: ColorMode): boolean {
  const next = mode === "light" ? lightThemeColors : darkThemeColors
  if (next === systemColors) return false
  systemColors = next
  return true
}

/** 当前生效色板（供需要显式取值的场景）。 */
export function getSystemColors(): typeof darkThemeColors | typeof lightThemeColors {
  return systemColors
}

/**
 * 聊天转录各块背景色；markdown 渲染沿用 assistant/tool 两种底色以保持一致。
 * 使用 getter 渲染时求值，切换色板后无需重建本对象即跟随新色板。
 */
export const blockColors = {
  get plain() {
    return systemColors.bgDefault
  },
  get user() {
    return systemColors.bgUser
  },
  get assistant() {
    return systemColors.bgAssistant
  },
  get thinking() {
    return systemColors.bgDefault
  },
  get tool() {
    return systemColors.bgTool
  },
  get toolGroup() {
    return systemColors.bgTool
  },
}
