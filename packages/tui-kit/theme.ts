/**
 * AizenAssistant TUI 统一颜色表。
 *
 * 所有 TUI 渲染颜色必须从本表取色，禁止在组件内硬编码十六进制色值。
 * 当前仅提供一套（深色终端）取值；后续支持终端深浅配色时，
 * 在此扩展为 { dark, light } 两套取值并增加切换逻辑，组件侧无需改动。
 */

/** 统一颜色表：文字色、背景色与语法高亮色。 */
export const systemColors = {
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
  /** 黯淡背景：弱化场景（禁用态、遮罩）；当前暂无消费者，为深浅切换预留。 */
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
} as const

/** 聊天转录各块背景色；markdown 渲染沿用 assistant/tool 两种底色以保持一致。 */
export const blockColors = {
  plain: systemColors.bgDefault,
  user: systemColors.bgUser,
  assistant: systemColors.bgAssistant,
  thinking: systemColors.bgDefault,
  tool: systemColors.bgTool,
  toolGroup: systemColors.bgTool,
} as const
