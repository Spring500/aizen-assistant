import { TextRenderable } from "@opentui/core"
import type { HumanReviewRequest } from "../../packages/core/tool-permissions/types.ts"
import type { OverlayHandle, OverlayManager } from "../../packages/tui-kit/overlay-manager.ts"
import { systemColors } from "../../packages/tui-kit/theme.ts"

function evidence(request: HumanReviewRequest): string {
  const details = request.assessment.details
  if (details && typeof details === "object" && !Array.isArray(details)) {
    if (request.toolName === "bash" && typeof details.command === "string") return details.command
    if (request.toolName === "write" && typeof details.content === "string") return details.content
    if (request.toolName === "edit") return JSON.stringify(details.edits ?? details, null, 2)
  }
  return JSON.stringify(request.arguments, null, 2)
}

function content(request: HumanReviewRequest, expanded: boolean, index: number, total: number): string {
  const lines = [
    `请求 ${index + 1}/${total} · ${request.toolName}`,
    `意图：${request.declaredIntent}`,
    `风险：${request.assessment.risk}`,
    `动作：${request.assessment.summary}`,
    `范围：${request.assessment.targets.join("，") || "未识别"}`,
    `原因：${request.aiDecision?.reason ?? request.aiError ?? request.assessment.reason}`,
  ]
  if (expanded) lines.push("", "完整内容：", evidence(request))
  else lines.push("", "按 E 展开完整命令、正文或编辑内容")
  return lines.join("\n")
}

export type PermissionReviewController = {
  update(requests: HumanReviewRequest[]): void
  close(): void
}

/** 打开可浏览待审批队列的工具权限审核页。 */
export function createPermissionReview(
  overlays: OverlayManager,
  requests: HumanReviewRequest[],
  answer: (requestId: string, decision: "approve" | "deny") => void,
  signal?: AbortSignal,
): PermissionReviewController {
  let current = 0
  let expanded = false
  let queue = requests
  let handle: OverlayHandle | undefined
  const text = new TextRenderable(overlays.renderer, {
    id: "permission-review-content",
    position: "absolute",
    width: "100%",
    height: "100%",
    wrapMode: "word",
    fg: systemColors.secondary,
    content: "",
  })
  const render = () => {
    if (queue.length === 0) {
      handle?.close()
      return
    }
    current = Math.min(current, queue.length - 1)
    const request = queue[current]
    if (request) text.content = content(request, expanded, current, queue.length)
  }
  const actions = () => [
    {
      id: "approve",
      key: { name: "return" },
      label: "Enter 批准本次",
      run: () => {
        const request = queue[current]
        if (request) answer(request.requestId, "approve")
      },
    },
    {
      id: "deny",
      key: { name: "d" },
      label: "D 拒绝",
      run: () => {
        const request = queue[current]
        if (request) answer(request.requestId, "deny")
      },
    },
    {
      id: "expand",
      key: { name: "e" },
      label: "E 展开",
      run: () => {
        expanded = !expanded
        render()
      },
    },
    {
      id: "previous",
      key: { name: "left" },
      label: "← 上一个",
      enabled: current > 0,
      run: () => {
        if (current > 0) current--
        render()
      },
    },
    {
      id: "next",
      key: { name: "right" },
      label: "→ 下一个",
      enabled: current + 1 < queue.length,
      run: () => {
        if (current + 1 < queue.length) current++
        render()
      },
    },
  ]
  handle = overlays.open({
    id: "permission-review",
    title: "工具权限审核",
    description: "批准只作用于当前工具调用",
    contentHeight: 18,
    actions: actions(),
    ...(signal ? { signal } : {}),
  })
  handle.content.add(text)
  render()
  return {
    update(requests) {
      const currentId = queue[current]?.requestId
      queue = requests
      const nextIndex = currentId ? queue.findIndex((request) => request.requestId === currentId) : -1
      current = nextIndex >= 0 ? nextIndex : Math.min(current, Math.max(0, queue.length - 1))
      handle?.setActions(actions())
      render()
    },
    close() {
      handle?.close()
    },
  }
}
