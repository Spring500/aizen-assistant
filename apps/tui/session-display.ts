import type { SessionSummary } from "../../packages/core/session-store.ts"
import type { RichSelectorItem } from "../../packages/tui-kit/rich-selector.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"

/** 将会话摘要转换为选择器行，并展示当前实例与其他实例的占用状态。 */
export function sessionDisplay(
  session: SessionSummary,
  currentSessionId?: string,
): Omit<RichSelectorItem<string>, "value"> {
  const isCurrent = session.lockState === "current" || session.sessionId === currentSessionId
  const isOccupied = session.lockState === "occupied"
  const marker = isCurrent ? " [当前]" : isOccupied ? " [已打开]" : ""
  const color = isCurrent
    ? systemColors.sessionCurrent
    : isOccupied
      ? systemColors.sessionOccupied
      : systemColors.header
  return {
    segments: [
      ...(session.name ? [{ text: session.name, color, bold: true }, { text: "  " }] : []),
      {
        text: session.sessionId,
        color: isCurrent || isOccupied ? color : systemColors.shortcuts,
        italic: true,
        dim: !isCurrent && !isOccupied,
      },
      ...(marker ? [{ text: marker, color, bold: true }] : []),
    ],
    details: [
      { text: `${session.updatedAt} · ${session.preview}`, color: systemColors.shortcuts, dim: true },
      ...(isOccupied ? [{ text: " · 当前实例不可打开", color: systemColors.sessionOccupied }] : []),
    ],
    ...(isOccupied ? { disabled: true, disabledReason: "会话正在被其他 Agent 使用" } : {}),
  }
}
