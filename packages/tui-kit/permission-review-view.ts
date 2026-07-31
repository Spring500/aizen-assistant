import { TextRenderable } from "@opentui/core"
import type { HumanReviewRequest } from "../core/tool-permissions/types.ts"
import { selectEditableItem } from "./editable-selector.ts"
import type { OverlayManager } from "./overlay-manager.ts"
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
  signal?: AbortSignal,
): Promise<void> {
  const full = evidence(request)
  await new Promise<void>((resolve) => {
    let settled = false
    let offset = 0
    const pageSize = 16
    const lines = full.content.split("\n")
    const handle = overlays.open({
      id: `permission-evidence-${request.requestId}`,
      title: full.title,
      description: "内容按终端宽度折行；显示位置以原始行计数",
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
      offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - pageSize)))
      text.content = lines.slice(offset, offset + pageSize).join("\n")
      handle.setDescription(
        `原始行 ${Math.min(offset + 1, Math.max(1, lines.length))}-${Math.min(offset + pageSize, lines.length)} / ${lines.length}`,
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
  | { decision: "approve" }
  | { decision: "deny"; reason?: string }
  | { decision: "abort" }

export type PermissionReviewController = {
  update(requests: HumanReviewRequest[]): void
  close(): void
}

/** 打开工具审核摘要，并以可编辑选择菜单提交通过、拒绝或查看完整内容。 */
export function createPermissionReviewView(
  overlays: OverlayManager,
  requests: HumanReviewRequest[],
  answer: (requestId: string, answer: PermissionReviewAnswer) => void,
  signal?: AbortSignal,
): PermissionReviewController {
  let queue = requests
  let current = 0
  const denyDrafts = new Map<string, string>()
  let closed = false
  let controller: AbortController | undefined

  const open = () => {
    if (closed || queue.length === 0) return
    current = Math.min(current, queue.length - 1)
    const request = queue[current]
    if (!request) return
    controller = new AbortController()
    const abort = () => controller?.abort()
    signal?.addEventListener("abort", abort, { once: true })
    void selectEditableItem<"approve" | "deny" | "details">(
      overlays,
      `permission-review-${request.requestId}`,
      () => [
        {
          name: "通过",
          description: `风险：${riskLabels[request.assessment.risk]} · ${request.assessment.reason}`,
          value: "approve",
          tone: "success",
        },
        {
          id: `deny-${request.requestId}`,
          name: `拒绝  ${denyDrafts.get(request.requestId) ?? ""}`,
          description: "拒绝理由可选；留空时 Agent 会得知用户未提供理由",
          value: "deny",
          tone: "danger",
          edit: {
            label: "拒绝  ",
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
        title: `工具权限审核 · 请求 ${current + 1}/${queue.length}`,
        header: [
          { text: `${request.toolName} · ${request.declaredIntent} · `, dim: true },
          {
            text: `风险：${riskLabels[request.assessment.risk]}`,
            color: riskColors[request.assessment.risk],
            bold: request.assessment.risk === "high" || request.assessment.risk === "critical",
          },
        ],
        signal: controller.signal,
      },
    ).then(async (selection) => {
      signal?.removeEventListener("abort", abort)
      if (closed) return
      if (!selection) {
        answer(request.requestId, { decision: "abort" })
        return
      }
      if (selection === "details") {
        await showEvidence(overlays, request)
        open()
        return
      }
      if (selection === "approve") answer(request.requestId, { decision: "approve" })
      else {
        const reason = denyDrafts.get(request.requestId)?.trim()
        answer(request.requestId, { decision: "deny", ...(reason ? { reason } : {}) })
      }
    })
  }

  open()
  return {
    update(requests) {
      const currentId = queue[current]?.requestId
      queue = requests
      if (queue.length === 0) {
        controller?.abort()
        return
      }
      const next = currentId ? queue.findIndex((request) => request.requestId === currentId) : -1
      if (next >= 0) current = next
      else {
        current = Math.min(current, queue.length - 1)
        controller?.abort()
        queueMicrotask(open)
      }
    },
    close() {
      closed = true
      controller?.abort()
    },
  }
}

export { riskColors }
