import {
  CodeRenderable,
  type MarkdownOptions,
  MarkdownRenderable,
  type RenderContext,
  SyntaxStyle,
  TextRenderable,
  infoStringToFiletype,
} from "@opentui/core"
import { isMathCodeBlock, prepareMarkdownForTerminal } from "./markdown.ts"
import { systemColors } from "./theme.ts"

/** 聊天转录各块背景色；markdown 渲染沿用 assistant/tool 两种底色以保持一致。 */
export const blockColors = {
  plain: "#252936",
  user: "#66551a",
  assistant: "#1f2937",
  thinking: "#252936",
  tool: "#292c31",
  toolGroup: "#292c31",
} as const

export type AssistantMarkdownStyles = {
  markdown: SyntaxStyle
  code: SyntaxStyle
}

/** 助手消息 markdown 的语法着色样式；供聊天转录与其它需要同款 markdown 的面板复用。 */
export function createAssistantMarkdownStyles(): AssistantMarkdownStyles {
  const markdownBackground = blockColors.assistant
  const codeBackground = blockColors.tool
  return {
    markdown: SyntaxStyle.fromStyles({
      default: { fg: "#f3f4f6", bg: markdownBackground },
      conceal: { fg: systemColors.secondary, bg: markdownBackground, dim: true },
      "markup.heading": { fg: systemColors.header, bg: markdownBackground, bold: true },
      "markup.heading.1": { fg: "#f472b6", bg: markdownBackground, bold: true },
      "markup.heading.2": { fg: "#22d3ee", bg: markdownBackground, bold: true },
      "markup.heading.3": { fg: "#a78bfa", bg: markdownBackground, bold: true },
      "markup.heading.4": { fg: "#c4b5fd", bg: markdownBackground, bold: true },
      "markup.heading.5": { fg: "#d8b4fe", bg: markdownBackground, bold: true },
      "markup.heading.6": { fg: "#e9d5ff", bg: markdownBackground, bold: true, dim: true },
      "markup.strong": { fg: "#f3f4f6", bg: markdownBackground, bold: true },
      "markup.italic": { fg: "#f3f4f6", bg: markdownBackground, italic: true },
      "markup.strikethrough": { fg: "#f3f4f6", bg: markdownBackground, dim: true },
      "markup.raw": { fg: systemColors.live, bg: markdownBackground },
      "markup.link": { fg: systemColors.sessionStatus, bg: markdownBackground, underline: true },
      "markup.link.label": { fg: systemColors.sessionStatus, bg: markdownBackground, underline: true },
      "markup.link.url": { fg: systemColors.secondary, bg: markdownBackground, underline: true },
      "markup.quote": { fg: systemColors.secondary, bg: markdownBackground, italic: true },
      "markup.list": { fg: systemColors.header, bg: markdownBackground, bold: true },
      "punctuation.special": { fg: systemColors.secondary, bg: markdownBackground },
    }),
    code: SyntaxStyle.fromStyles({
      default: { fg: "#d1d5db", bg: codeBackground },
      keyword: { fg: "#f472b6", bg: codeBackground, bold: true },
      string: { fg: "#86efac", bg: codeBackground },
      number: { fg: "#facc15", bg: codeBackground },
      boolean: { fg: "#facc15", bg: codeBackground, bold: true },
      comment: { fg: "#9ca3af", bg: codeBackground, italic: true, dim: true },
      type: { fg: "#60a5fa", bg: codeBackground },
      "type.builtin": { fg: "#60a5fa", bg: codeBackground, bold: true },
      function: { fg: "#c4b5fd", bg: codeBackground },
      "function.call": { fg: "#c4b5fd", bg: codeBackground },
      "function.method": { fg: "#c4b5fd", bg: codeBackground },
      "function.method.call": { fg: "#c4b5fd", bg: codeBackground },
      property: { fg: "#67e8f9", bg: codeBackground },
      "variable.builtin": { fg: "#fb923c", bg: codeBackground },
      "variable.member": { fg: "#67e8f9", bg: codeBackground },
      operator: { fg: "#f9a8d4", bg: codeBackground },
      "punctuation.bracket": { fg: systemColors.secondary, bg: codeBackground },
      "punctuation.delimiter": { fg: systemColors.secondary, bg: codeBackground },
    }),
  }
}

/** 构造与聊天转录一致的 markdown 渲染器；代码块支持语法高亮，公式块单独渲染。 */
export function createAssistantMarkdownRenderer(
  context: RenderContext,
  id: string,
  content: string,
  styles: AssistantMarkdownStyles,
): MarkdownRenderable {
  const renderNode: NonNullable<MarkdownOptions["renderNode"]> & { codeBlockOnly?: boolean } = (token) => {
    if (token.type !== "code") return undefined
    if (isMathCodeBlock(token)) {
      return new TextRenderable(context, {
        id: `${id}-formula`,
        content: token.text,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        fg: "#facc15",
        bg: blockColors.tool,
        paddingLeft: 2,
        paddingRight: 2,
      })
    }
    const filetype = infoStringToFiletype(token.lang ?? "")
    return new CodeRenderable(context, {
      id: `${id}-code`,
      content: token.text,
      syntaxStyle: styles.code,
      width: "100%",
      wrapMode: "word",
      fg: "#d1d5db",
      bg: blockColors.tool,
      paddingLeft: 1,
      paddingRight: 1,
      drawUnstyledText: true,
      ...(filetype ? { filetype } : {}),
    })
  }
  renderNode.codeBlockOnly = true

  return new MarkdownRenderable(context, {
    id,
    content: prepareMarkdownForTerminal(content),
    syntaxStyle: styles.markdown,
    width: "100%",
    fg: "#f3f4f6",
    bg: blockColors.assistant,
    streaming: false,
    tableOptions: { widthMode: "content" },
    renderNode,
  })
}
