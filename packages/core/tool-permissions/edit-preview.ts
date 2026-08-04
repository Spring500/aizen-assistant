import { createTwoFilesPatch } from "diff"

export type ExactEdit = { oldText: string; newText: string }

export type EditPreview =
  | { ok: true; patch: string; content: string }
  | { ok: false; reason: string; failedEditIndex?: number }

function occurrenceIndexes(content: string, value: string): number[] {
  if (!value) return []
  const result: number[] = []
  let offset = 0
  while (offset <= content.length - value.length) {
    const index = content.indexOf(value, offset)
    if (index < 0) break
    result.push(index)
    offset = index + Math.max(1, value.length)
  }
  return result
}

/** 在不修改文件的前提下预演全部精确替换，并生成标准 unified diff。 */
export function previewExactEdits(path: string, content: string, edits: ExactEdit[]): EditPreview {
  if (edits.length === 0) return { ok: false, reason: "替换列表不能为空" }
  const ranges: Array<{ start: number; end: number; replacement: string; index: number }> = []
  for (const [index, edit] of edits.entries()) {
    if (!edit.oldText)
      return { ok: false, reason: `第 ${index + 1} 个替换块的 oldText 不能为空`, failedEditIndex: index }
    const matches = occurrenceIndexes(content, edit.oldText)
    if (matches.length === 0)
      return {
        ok: false,
        reason: `第 ${index + 1} 个替换块的 oldText 在当前文件中没有匹配`,
        failedEditIndex: index,
      }
    if (matches.length > 1)
      return {
        ok: false,
        reason: `第 ${index + 1} 个替换块的 oldText 在当前文件中匹配 ${matches.length} 次，必须唯一`,
        failedEditIndex: index,
      }
    const start = matches[0] ?? 0
    ranges.push({ start, end: start + edit.oldText.length, replacement: edit.newText, index })
  }
  ranges.sort((left, right) => left.start - right.start)
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1]
    const current = ranges[index]
    if (previous && current && current.start < previous.end)
      return {
        ok: false,
        reason: `第 ${current.index + 1} 个替换块与第 ${previous.index + 1} 个替换块重叠`,
        failedEditIndex: current.index,
      }
  }
  let output = content
  for (const range of [...ranges].reverse())
    output = `${output.slice(0, range.start)}${range.replacement}${output.slice(range.end)}`
  return {
    ok: true,
    content: output,
    patch: createTwoFilesPatch(path, path, content, output, "原文件", "预览", { context: 3 }),
  }
}
