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
import { blockColors, systemColors } from "./theme.ts"

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
      default: { fg: systemColors.text, bg: markdownBackground },
      conceal: { fg: systemColors.dim, bg: markdownBackground, dim: true },
      "markup.heading": { fg: systemColors.mdHeading1, bg: markdownBackground, bold: true },
      "markup.heading.1": { fg: systemColors.mdHeading1, bg: markdownBackground, bold: true },
      "markup.heading.2": { fg: systemColors.mdHeading2, bg: markdownBackground, bold: true },
      "markup.heading.3": { fg: systemColors.mdHeading3, bg: markdownBackground, bold: true },
      "markup.heading.4": { fg: systemColors.mdHeading4, bg: markdownBackground, bold: true },
      "markup.heading.5": { fg: systemColors.mdHeading5, bg: markdownBackground, bold: true },
      "markup.heading.6": { fg: systemColors.mdHeading6, bg: markdownBackground, bold: true, dim: true },
      "markup.strong": { fg: systemColors.text, bg: markdownBackground, bold: true },
      "markup.italic": { fg: systemColors.text, bg: markdownBackground, italic: true },
      "markup.strikethrough": { fg: systemColors.text, bg: markdownBackground, dim: true },
      "markup.raw": { fg: systemColors.mdInlineCode, bg: markdownBackground },
      "markup.link": { fg: systemColors.mdLink, bg: markdownBackground, underline: true },
      "markup.link.label": { fg: systemColors.mdLink, bg: markdownBackground, underline: true },
      "markup.link.url": { fg: systemColors.mdLinkUrl, bg: markdownBackground, underline: true },
      "markup.quote": { fg: systemColors.mdQuote, bg: markdownBackground, italic: true },
      "markup.list": { fg: systemColors.mdListBullet, bg: markdownBackground, bold: true },
      "punctuation.special": { fg: systemColors.mdPunctuation, bg: markdownBackground },
    }),
    code: SyntaxStyle.fromStyles({
      default: { fg: systemColors.mdCodeBlock, bg: codeBackground },
      keyword: { fg: systemColors.syntaxKeyword, bg: codeBackground, bold: true },
      string: { fg: systemColors.syntaxString, bg: codeBackground },
      number: { fg: systemColors.syntaxNumber, bg: codeBackground },
      boolean: { fg: systemColors.syntaxNumber, bg: codeBackground, bold: true },
      comment: { fg: systemColors.dim, bg: codeBackground, italic: true, dim: true },
      type: { fg: systemColors.syntaxType, bg: codeBackground },
      "type.builtin": { fg: systemColors.syntaxType, bg: codeBackground, bold: true },
      function: { fg: systemColors.syntaxFunction, bg: codeBackground },
      "function.call": { fg: systemColors.syntaxFunction, bg: codeBackground },
      "function.method": { fg: systemColors.syntaxFunction, bg: codeBackground },
      "function.method.call": { fg: systemColors.syntaxFunction, bg: codeBackground },
      property: { fg: systemColors.syntaxProperty, bg: codeBackground },
      "variable.builtin": { fg: systemColors.syntaxVariable, bg: codeBackground },
      "variable.member": { fg: systemColors.syntaxProperty, bg: codeBackground },
      operator: { fg: systemColors.syntaxOperator, bg: codeBackground },
      "punctuation.bracket": { fg: systemColors.dim, bg: codeBackground },
      "punctuation.delimiter": { fg: systemColors.dim, bg: codeBackground },
    }),
  }
}

/**
 * 构造与聊天转录一致的 markdown 渲染器；代码块支持语法高亮，公式块单独渲染。
 * streaming 为 true 时先绘制未经树解析的预着色文本，避免等待异步高亮前出现空白；
 * 聊天转录走滚动回表面（自带 settle），保持默认 false 即可。
 */
export function createAssistantMarkdownRenderer(
  context: RenderContext,
  id: string,
  content: string,
  styles: AssistantMarkdownStyles,
  streaming = false,
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
        fg: systemColors.mdFormula,
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
      fg: systemColors.text,
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
    fg: systemColors.text,
    bg: blockColors.assistant,
    streaming,
    tableOptions: { widthMode: "content" },
    renderNode,
  })
}
