import { CliRenderEvents, TextRenderable } from "@opentui/core"
import { sensitiveFieldPaths } from "../core/tool-permissions/sanitizer.ts"
import type { HumanReviewRequest } from "../core/tool-permissions/types.ts"
import { selectEditableItem } from "./editable-selector.ts"
import type { OverlayManager } from "./overlay-manager.ts"
import { showPermissionDiff } from "./permission-diff-view.ts"
import { permissionParameterPreview } from "./permission-review-preview.ts"
import { systemColors } from "./theme.ts"

function evidence(request: HumanReviewRequest): { title: string; content: string } {
  const details = request.assessment.details
  if (details && typeof details === "object" && !Array.isArray(details)) {
    if (request.toolName === "bash" && typeof details.command === "string")
      return { title: "完整命令", content: details.command }
    if (request.toolName === "write" && typeof details.content === "string")
      return { title: "完整正文", content: details.content }
    if (request.toolName === "edit")
      return { title: "完整编辑内容", content: JSON.stringify(details.edits ?? details, null, 2) }
  }
  return { title: "完整参数", content: JSON.stringify(request.arguments, null, 2) }
}

const riskLabels = { low: "低", medium: "中", high: "高", critical: "严重" } as const
const riskColors = {
  low: systemColors.statusIdle,
  medium: systemColors.statusRunning,
  high: systemColors.live,
  critical: systemColors.statusError,
} as const

async function showEvidence(
  overlays: OverlayManager,
  request: HumanReviewRequest,
  onViewedToEnd: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const details = request.assessment.details
  if (request.toolName === "edit" && details && typeof details === "object" && !Array.isArray(details)) {
    const patch = typeof details.patch === "string" ? details.patch : undefined
    if (patch) {
      await showPermissionDiff(overlays, {
        id: `permission-edit-diff-${request.requestId}`,
        title: `编辑预览：${request.assessment.targets[0] ?? request.toolName}`,
        patch,
        ...(signal ? { signal } : {}),
        onViewedToEnd,
      })
      return
    }
  }
  const full = evidence(request)
  const findings = request.assessment.findings
    .map((item) => `[${riskLabels[item.severity]}] ${item.summary}\n证据：${item.evidence}`)
    .join("\n\n")
  if (findings) full.content = `${findings}\n\n${full.content}`
  await new Promise<void>((resolve) => {
    let settled = false
    let offset = 0
    const pageSize = 16
    const linesForWidth = () => {
      const wrapWidth = Math.max(20, overlays.renderer.terminalWidth - 2)
      return full.content.split("\n").flatMap((line) => {
        if (!line) return [""]
        const visual: string[] = []
        let current = ""
        for (const character of line) {
          if (Bun.stringWidth(current + character) > wrapWidth) {
            visual.push(current)
            current = character
          } else current += character
        }
        visual.push(current)
        return visual
      })
    }
    let lines = linesForWidth()
    const handle = overlays.open({
      id: `permission-evidence-${request.requestId}`,
      title: full.title,
      description: "内容按终端宽度折行；显示位置以视觉行计数",
      contentHeight: pageSize,
      actions: [],
      ...(signal ? { signal } : {}),
      onCancel: () => finish(),
    })
    const text = new TextRenderable(overlays.renderer, {
      id: `permission-evidence-${request.requestId}-content`,
      position: "absolute",
      width: "100%",
      height: "100%",
      wrapMode: "word",
      fg: systemColors.secondary,
      content: "",
    })
    handle.content.add(text)
    const render = () => {
      lines = linesForWidth()
      offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - pageSize)))
      if (offset + pageSize >= lines.length) onViewedToEnd()
      text.content = lines.slice(offset, offset + pageSize).join("\n")
      handle.setDescription(
        `视觉行 ${Math.min(offset + 1, Math.max(1, lines.length))}-${Math.min(offset + pageSize, lines.length)} / ${lines.length}`,
      )
    }
    const finish = () => {
      if (settled) return
      settled = true
      handle.close()
      resolve()
    }
    handle.setActions([
      {
        id: "line",
        key: { name: "up" },
        alternateKeys: [{ name: "down" }],
        label: "↑↓ 逐行",
        run: (key) => {
          offset += key.name === "up" ? -1 : 1
          render()
        },
      },
      {
        id: "page",
        key: { name: "pageup" },
        alternateKeys: [{ name: "pagedown" }],
        label: "PgUp/PgDn 翻页",
        run: (key) => {
          offset += key.name === "pageup" ? -pageSize : pageSize
          render()
        },
      },
      { id: "return", key: { name: "return" }, label: "Enter 返回", run: finish },
      { id: "cancel", key: { name: "escape" }, label: "Esc 返回", run: finish },
    ])
    render()
  })
}

export type PermissionReviewAnswer =
  | {
      decision: "submit"
      batchId: string
      answers: Array<{ requestId: string; decision: "approve" | "deny"; reason?: string }>
    }
  | { decision: "abort"; batchId: string }

export type PermissionReviewController = {
  update(requests: HumanReviewRequest[]): void
  close(): void
}

type DraftDecision = { decision: "approve" } | { decision: "deny"; reason?: string }

type SummaryResult = { type: "submit" } | { type: "return"; index: number } | { type: "abort" }

async function showPermissionSummary(
  overlays: OverlayManager,
  requests: HumanReviewRequest[],
  decisions: Map<string, DraftDecision>,
  initialIndex: number,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  return new Promise((resolve) => {
    const pageSize = 16
    let settled = false
    let selected = Math.max(0, Math.min(initialIndex, requests.length - 1))
    let offset = 0
    let lineStarts: number[] = []
    let lines: string[] = []
    const handle = overlays.open({
      id: `permission-summary-${requests[0]?.batchId ?? "batch"}`,
      title: `工具权限审核 · 汇总 ${requests.length} 项`,
      description: "←/→ 选择要返回修改的工具；Ctrl+Enter 确认提交",
      contentHeight: pageSize,
      actions: [],
      ...(signal ? { signal } : {}),
      onCancel: () => finish({ type: "abort" }),
    })
    const content = new TextRenderable(overlays.renderer, {
      id: `permission-summary-${requests[0]?.batchId ?? "batch"}-content`,
      position: "absolute",
      width: "100%",
      height: "100%",
      wrapMode: "none",
      truncate: true,
      fg: systemColors.secondary,
      content: "",
    })
    handle.content.add(content)

    const buildLines = () => {
      const result: string[] = []
      lineStarts = []
      for (const [index, request] of requests.entries()) {
        lineStarts.push(result.length)
        const decision = decisions.get(request.requestId)
        const marker = index === selected ? "▶" : " "
        const state =
          decision?.decision === "approve" ? "✓ 通过" : decision?.decision === "deny" ? "✗ 拒绝" : "○ 未决定"
        result.push(`${marker} ${index + 1}. ${request.toolName} · ${state}`)
        for (const line of permissionParameterPreview(request, overlays.renderer.terminalWidth, 3).lines)
          result.push(`    ${line}`)
        if (decision?.decision === "deny") result.push(`    拒绝理由：${decision.reason ?? "未提供"}`)
        result.push("")
      }
      lines = result
    }
    const render = (ensureSelected = false) => {
      buildLines()
      if (ensureSelected) {
        const start = lineStarts[selected] ?? 0
        const next = lineStarts[selected + 1] ?? lines.length
        if (start < offset) offset = start
        else if (next > offset + pageSize) offset = Math.max(start, next - pageSize)
      }
      offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - pageSize)))
      content.content = lines.slice(offset, offset + pageSize).join("\n")
      handle.setDescription(
        `已选择 ${selected + 1}/${requests.length}；←/→ 选择工具，Enter 返回修改，Ctrl+Enter 确认提交`,
      )
    }
    const finish = (result: SummaryResult) => {
      if (settled) return
      settled = true
      overlays.renderer.off(CliRenderEvents.RESIZE, onResize)
      handle.close()
      resolve(result)
    }
    const onResize = () => render(true)
    overlays.renderer.on(CliRenderEvents.RESIZE, onResize)
    handle.setActions([
      {
        id: "tool",
        key: { name: "left" },
        alternateKeys: [{ name: "right" }],
        label: "←/→ 选择工具",
        run: (key) => {
          selected = Math.max(0, Math.min(requests.length - 1, selected + (key.name === "left" ? -1 : 1)))
          render(true)
        },
      },
      {
        id: "scroll",
        key: { name: "up" },
        alternateKeys: [{ name: "down" }, { name: "pageup" }, { name: "pagedown" }],
        label: "↑↓ 滚动",
        run: (key) => {
          const delta = key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -pageSize : pageSize
          offset += delta
          render()
        },
      },
      {
        id: "return",
        key: { name: "return" },
        label: "Enter 返回修改",
        run: () => finish({ type: "return", index: selected }),
      },
      {
        id: "submit",
        key: { name: "return", ctrl: true },
        label: "Ctrl+Enter 确认提交",
        run: () => finish({ type: "submit" }),
      },
      { id: "cancel", key: { name: "escape" }, label: "Esc 中止", run: () => finish({ type: "abort" }) },
    ])
    render(true)
  })
}

/** 打开工具批次审核页；逐项决定后只在汇总页一次提交。 */
export function createPermissionReviewView(
  overlays: OverlayManager,
  requests: HumanReviewRequest[],
  answer: (answer: PermissionReviewAnswer) => void,
  signal?: AbortSignal,
): PermissionReviewController {
  let queue = requests
  let current = 0
  const decisions = new Map<string, DraftDecision>()
  const denyDrafts = new Map<string, string>()
  const viewedEvidence = new Set<string>()
  let closed = false
  let controller: AbortController | undefined
  let navigationPending = false

  const navigate = (direction: "previous" | "next") => {
    if (queue.length === 0) return
    const last = queue.length
    current = Math.max(0, Math.min(last, current + (direction === "previous" ? -1 : 1)))
    navigationPending = true
  }

  const open = () => {
    if (closed || queue.length === 0) return
    current = Math.max(0, Math.min(current, queue.length))
    if (current === queue.length) {
      openSummary()
      return
    }
    const request = queue[current]
    if (!request) return
    controller = new AbortController()
    const abort = () => controller?.abort()
    const preview = () => permissionParameterPreview(request, overlays.renderer.terminalWidth, 3)
    const evidenceWidth = Math.max(20, overlays.renderer.terminalWidth - 2)
    const hiddenHighEvidence = request.assessment.findings.some(
      (item) =>
        (item.severity === "high" || item.severity === "critical") &&
        Bun.stringWidth(`证据：${item.evidence}`) > evidenceWidth,
    )
    const sensitivePaths = sensitiveFieldPaths(request.arguments, request.sensitiveFields)
    const sensitiveLines =
      sensitivePaths.length > 0 ? [`⚠ 敏感字段（本地原值未脱敏）：${sensitivePaths.join("、")}`] : []
    const findingLines = request.assessment.findings.flatMap((item) => [
      [
        {
          text: `[${riskLabels[item.severity]}] ${item.summary}`,
          color: riskColors[item.severity],
          bold: item.severity === "high" || item.severity === "critical",
        },
      ],
      [{ text: `证据：${item.evidence}`, color: riskColors[item.severity] }],
    ])
    const approvalBlocked = (preview().truncated || hiddenHighEvidence) && !viewedEvidence.has(request.requestId)
    const existing = decisions.get(request.requestId)
    signal?.addEventListener("abort", abort, { once: true })
    void selectEditableItem<"approve" | "deny" | "details">(
      overlays,
      `permission-review-${request.requestId}`,
      () => [
        {
          name: `${existing?.decision === "approve" ? "✓ " : ""}通过`,
          description: approvalBlocked
            ? hiddenHighEvidence
              ? "高风险证据显示不全；请先打开完整内容并滚动到末尾"
              : "参数预览有省略；请先打开完整内容并滚动到末尾"
            : `风险：${riskLabels[request.assessment.risk]} · ${request.assessment.reason}`,
          value: "approve",
          tone: "success",
          disabled: approvalBlocked,
          disabledReason: hiddenHighEvidence
            ? "高风险证据显示不全；请先打开完整内容并滚动到末尾"
            : "参数预览有省略；请先打开完整内容并滚动到末尾",
        },
        {
          id: `deny-${request.requestId}`,
          name: `${existing?.decision === "deny" ? "✗ " : ""}拒绝理由  ${denyDrafts.get(request.requestId) ?? ""}`,
          description: "拒绝理由可选；留空时 Agent 会得知用户未提供理由",
          value: "deny",
          tone: "danger",
          edit: {
            label: "拒绝理由  ",
            value: denyDrafts.get(request.requestId) ?? "",
            placeholder: "可选拒绝理由",
            draft: (value) => denyDrafts.set(request.requestId, value),
            validate: (value) => (Array.from(value).length > 500 ? "拒绝理由不能超过 500 个字符" : undefined),
            submit: (value) => {
              denyDrafts.set(request.requestId, value)
              return "deny"
            },
          },
        },
        {
          name: `查看${evidence(request).title}`,
          description: "打开可逐行或翻页滚动的完整内容",
          value: "details",
          tone: "primary",
        },
      ],
      {
        title: `工具权限审核 · 工具 ${current + 1}/${queue.length}`,
        header: [
          { text: `${request.toolName} · ${request.declaredIntent} · `, dim: true },
          {
            text: `风险：${riskLabels[request.assessment.risk]}`,
            color: riskColors[request.assessment.risk],
            bold: request.assessment.risk === "high" || request.assessment.risk === "critical",
          },
          {
            text: ` · 判定原因：${request.assessment.reason}`,
            color: riskColors[request.assessment.risk],
          },
        ],
        headerLinesForWidth: (width) => [
          ...sensitiveLines,
          ...findingLines,
          ...permissionParameterPreview(request, width, 3).lines,
        ],
        headerHeight: 3 + sensitiveLines.length + findingLines.length,
        navigate,
        signal: controller.signal,
      },
    ).then(async (selection) => {
      signal?.removeEventListener("abort", abort)
      if (closed) return
      if (navigationPending) {
        navigationPending = false
        queueMicrotask(open)
        return
      }
      if (!selection) {
        answer({ decision: "abort", batchId: request.batchId })
        return
      }
      if (selection === "details") {
        await showEvidence(overlays, request, () => viewedEvidence.add(request.requestId))
        open()
        return
      }
      if (selection === "approve") decisions.set(request.requestId, { decision: "approve" })
      else {
        const reason = denyDrafts.get(request.requestId)?.trim()
        decisions.set(request.requestId, { decision: "deny", ...(reason ? { reason } : {}) })
      }
      current = Math.min(queue.length, current + 1)
      open()
    })
  }

  const openSummary = () => {
    const batchId = queue[0]?.batchId
    if (!batchId) return
    if (!queue.every((request) => decisions.has(request.requestId))) {
      current = queue.findIndex((request) => !decisions.has(request.requestId))
      open()
      return
    }
    controller = new AbortController()
    const abort = () => controller?.abort()
    signal?.addEventListener("abort", abort, { once: true })
    void showPermissionSummary(overlays, queue, decisions, Math.max(0, queue.length - 1), controller.signal).then(
      (result) => {
        signal?.removeEventListener("abort", abort)
        if (closed) return
        if (result.type === "abort") {
          answer({ decision: "abort", batchId })
          return
        }
        if (result.type === "return") {
          current = result.index
          open()
          return
        }
        answer({
          decision: "submit",
          batchId,
          answers: queue.map((request) => {
            const decision = decisions.get(request.requestId)
            if (!decision) throw new Error("权限批次存在未决定项")
            return { requestId: request.requestId, ...decision }
          }),
        })
      },
    )
  }

  open()
  return {
    update(requests) {
      const batchId = queue[0]?.batchId
      queue = batchId ? requests.filter((request) => request.batchId === batchId) : requests
      if (queue.length === 0) controller?.abort()
    },
    close() {
      closed = true
      controller?.abort()
    },
  }
}

export { riskColors }
