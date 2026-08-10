import { CliRenderEvents, TextRenderable } from "@opentui/core"
import { sensitiveFieldPaths } from "../core/tool-permissions/sanitizer.ts"
import type { HumanReviewRequest } from "../core/tool-permissions/types.ts"
import { selectEditableItem, type EditableHeaderLine } from "./editable-selector.ts"
import type { OverlayManager } from "./overlay-manager.ts"
import { showPermissionDiff } from "./permission-diff-view.ts"
import { permissionParameterPreview } from "./permission-review-preview.ts"
import { createScrollableTextView } from "./scrollable-text-view.ts"
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
  const tags = request.assessment.tags
    ?.map((item) => (item.evidence ? `${item.name}\n证据：${item.evidence}` : item.name))
    .join("\n\n")
  if (tags) full.content = `${tags}\n\n${full.content}`
  await new Promise<void>((resolve) => {
    let settled = false
    const pageSize = 16
    const handle = overlays.open({
      id: `permission-evidence-${request.requestId}`,
      title: full.title,
      description: "内容按终端宽度自动换行；显示位置以视觉行计数",
      contentHeight: pageSize,
      actions: [],
      ...(signal ? { signal } : {}),
      onCancel: () => finish(),
    })
    const text = createScrollableTextView(overlays.renderer, {
      id: `permission-evidence-${request.requestId}-content`,
      parent: handle.content,
      content: full.content,
      wrapMode: "word",
      fg: systemColors.secondary,
      onViewedToEnd,
      onStateChange: (state) =>
        handle.setDescription(`视觉行 ${state.firstLine}-${state.lastLine} / ${state.totalLines}`),
    })
    const finish = () => {
      if (settled) return
      settled = true
      text.dispose()
      handle.close()
      resolve()
    }
    handle.setActions([
      {
        id: "line",
        key: { name: "up" },
        alternateKeys: [{ name: "down" }],
        label: "↑↓ 逐行",
        run: (key) => text.scrollBy(key.name === "up" ? -1 : 1),
      },
      {
        id: "page",
        key: { name: "pageup" },
        alternateKeys: [{ name: "pagedown" }],
        label: "PgUp/PgDn 翻页",
        run: (key) => text.scrollPage(key.name === "pageup" ? -1 : 1),
      },
      { id: "return", key: { name: "return" }, label: "Enter 返回", run: finish },
      { id: "cancel", key: { name: "escape" }, label: "Esc 返回", run: finish },
    ])
    text.refresh()
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

type SummaryResult =
  | { type: "submit" }
  | { type: "return"; index: number }
  | { type: "page"; index: number }
  | { type: "abort" }

async function showPermissionSummary(
  overlays: OverlayManager,
  requests: HumanReviewRequest[],
  decisions: Map<string, DraftDecision>,
  initialIndex: number,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  return new Promise((resolve) => {
    const pageSize = 16
    const submitIndex = requests.length
    let settled = false
    let selected = Math.max(0, Math.min(initialIndex, submitIndex))
    let offset = 0
    let lineStarts: number[] = []
    let lines: string[] = []
    const handle = overlays.open({
      id: `permission-summary-${requests[0]?.batchId ?? "batch"}`,
      title: `工具权限审核 · 汇总 ${requests.length} 项`,
      description: "↑/↓ 选择工具或确认并提交；Enter 执行",
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
      lineStarts.push(result.length)
      result.push(`${selected === submitIndex ? "▶" : " "} 确认并提交`)
      lines = result
    }
    const render = (ensureSelected = false) => {
      buildLines()
      if (ensureSelected) {
        const start = lineStarts[selected] ?? lines.length - 1
        const next = selected === submitIndex ? lines.length : (lineStarts[selected + 1] ?? lines.length)
        if (start < offset) offset = start
        else if (next > offset + pageSize) offset = Math.max(start, next - pageSize)
      }
      offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - pageSize)))
      content.content = lines.slice(offset, offset + pageSize).join("\n")
      const undecided = requests.filter((request) => !decisions.has(request.requestId)).length
      handle.setDescription(
        undecided > 0
          ? `还有 ${undecided} 项未决定；↑/↓ 选择，Enter 执行`
          : `已选择 ${selected + 1}/${submitIndex + 1}；↑/↓ 选择，Enter 执行`,
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
        id: "move",
        key: { name: "up" },
        alternateKeys: [{ name: "down" }],
        label: "↑/↓ 选择",
        run: (key) => {
          selected = Math.max(0, Math.min(submitIndex, selected + (key.name === "up" ? -1 : 1)))
          render(true)
        },
      },
      {
        id: "select",
        key: { name: "return" },
        label: "Enter 执行",
        run: () => {
          if (selected < submitIndex) {
            finish({ type: "return", index: selected })
            return
          }
          const undecided = requests.filter((request) => !decisions.has(request.requestId)).length
          if (undecided > 0) {
            handle.setError(`还有 ${undecided} 项未决定，请完成全部审核后再提交`)
            return
          }
          finish({ type: "submit" })
        },
      },
      {
        id: "previous",
        key: { name: "left" },
        label: "← 上一页",
        run: () => finish({ type: "page", index: requests.length - 1 }),
      },
      {
        id: "next",
        key: { name: "right" },
        label: "→ 下一页",
        enabled: false,
        disabledReason: "汇总页已经是最后一页",
        run: () => {},
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
    const sensitivePaths = sensitiveFieldPaths(request.arguments, request.sensitiveFields)
    const sensitiveLines =
      sensitivePaths.length > 0 ? [`⚠ 敏感字段（本地原值未脱敏）：${sensitivePaths.join("、")}`] : []
    const tagLines: EditableHeaderLine[] = []
    for (const item of request.assessment.tags ?? []) {
      tagLines.push([{ text: item.name, bold: true }])
      if (item.evidence) tagLines.push([{ text: `证据：${item.evidence}` }])
    }
    const approvalBlocked = preview().truncated && !viewedEvidence.has(request.requestId)
    const existing = decisions.get(request.requestId)
    signal?.addEventListener("abort", abort, { once: true })
    void selectEditableItem<"approve" | "deny" | "details">(
      overlays,
      `permission-review-${request.requestId}`,
      () => [
        {
          name: `${existing?.decision === "approve" ? "✓ " : ""}通过`,
          description: approvalBlocked ? "参数预览有省略；请先打开完整内容并滚动到末尾" : request.assessment.reason,
          value: "approve",
          tone: "success",
          disabled: approvalBlocked,
          disabledReason: "参数预览有省略；请先打开完整内容并滚动到末尾",
        },
        {
          id: `deny-${request.requestId}`,
          name: `${existing?.decision === "deny" ? "✗ " : ""}拒绝理由  ${denyDrafts.get(request.requestId) ?? ""}`,
          description: "拒绝理由可选；留空时 Agent 会得知用户未提供理由",
          value: "deny",
          tone: "danger",
          edit: {
            label: `${existing?.decision === "deny" ? "✗ " : ""}拒绝理由  `,
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
          { text: `判定原因：${request.assessment.reason}` },
        ],
        headerLinesForWidth: (width) => [
          ...sensitiveLines,
          ...tagLines,
          ...permissionParameterPreview(request, width, 3).lines,
        ],
        headerHeight: 2 + sensitiveLines.length + tagLines.length,
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
      if (queue.length === 1) {
        const decision = decisions.get(request.requestId)
        if (!decision) throw new Error("单工具审批没有生成决定")
        answer({
          decision: "submit",
          batchId: request.batchId,
          answers: [{ requestId: request.requestId, ...decision }],
        })
        return
      }
      current = Math.min(queue.length, current + 1)
      open()
    })
  }

  const openSummary = () => {
    const batchId = queue[0]?.batchId
    if (!batchId) return
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
        if (result.type === "return" || result.type === "page") {
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
