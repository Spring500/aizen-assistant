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
  const issueLabels = [...new Set(session.issues.map((issue) => issue.label))]
  const marker = [isCurrent ? "当前" : undefined, ...issueLabels]
    .filter(Boolean)
    .map((label) => ` [${label}]`)
    .join("")
  // canForceOpen 仅为风险标记（含不兼容记录），不代表可打开；可操作性只看 canOpen。
  const hasAction = session.capabilities.canOpen
  const color = isCurrent ? systemColors.accent : isOccupied ? systemColors.warning : systemColors.accent
  return {
    segments: [
      ...(session.name ? [{ text: session.name, color, bold: true }, { text: "  " }] : []),
      {
        text: session.sessionId,
        color: isCurrent || isOccupied ? color : systemColors.dim,
        italic: true,
        dim: !isCurrent && !isOccupied,
      },
      ...(marker ? [{ text: marker, color, bold: true }] : []),
    ],
    details: [
      { text: `${session.updatedAt} · ${session.preview}`, color: systemColors.dim, dim: true },
      ...session.issues.map((issue) => ({ text: ` · ${issue.message}`, color: systemColors.warning })),
    ],
    ...(!hasAction ? { disabled: true, disabledReason: session.issues[0]?.message ?? "当前条目不可操作" } : {}),
  }
}
