import { TextRenderable } from "@opentui/core"
import type { HumanReviewRequest } from "../core/tool-permissions/types.ts"
import type { OverlayHandle, OverlayManager } from "./overlay-manager.ts"
import { systemColors } from "./theme.ts"

function evidence(request: HumanReviewRequest): string {
  const details = request.assessment.details
  if (details && typeof details === "object" && !Array.isArray(details)) {
    if (request.toolName === "bash" && typeof details.command === "string") return details.command
    if (request.toolName === "write" && typeof details.content === "string") return details.content
    if (request.toolName === "edit") return JSON.stringify(details.edits ?? details, null, 2)
  }
  return JSON.stringify(request.arguments, null, 2)
}

function lines(request: HumanReviewRequest, expanded: boolean, index: number, total: number): string[] {
  const result = [
    `请求 ${index + 1}/${total} · ${request.toolName}`,
    `意图：${request.declaredIntent}`,
    `风险：${request.assessment.risk}`,
    `动作：${request.assessment.summary}`,
    `范围：${request.assessment.targets.join("，") || "未识别"}`,
    `原因：${request.aiDecision?.reason ?? request.aiError ?? request.assessment.reason}`,
  ]
  if (expanded) result.push("", "完整内容：", ...evidence(request).split("\n"))
  else result.push("", "按 E 展开完整命令、正文或编辑内容")
  return result
}

export type PermissionReviewController = {
  update(requests: HumanReviewRequest[]): void
  close(): void
}

/** 打开可切换请求并滚动查看完整证据的工具权限审核页。 */
export function createPermissionReviewView(
  overlays: OverlayManager,
  requests: HumanReviewRequest[],
  answer: (requestId: string, decision: "approve" | "deny") => void,
  signal?: AbortSignal,
): PermissionReviewController {
  let current = 0
  let expanded = false
  let scrollOffset = 0
  let queue = requests
  let handle: OverlayHandle | undefined
  const visibleLines = 18
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
    if (!request) return
    const content = lines(request, expanded, current, queue.length)
    scrollOffset = Math.min(scrollOffset, Math.max(0, content.length - visibleLines))
    text.content = content.slice(scrollOffset, scrollOffset + visibleLines).join("\n")
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
        scrollOffset = 0
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
        scrollOffset = 0
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
        scrollOffset = 0
        render()
      },
    },
  ]
  handle = overlays.open({
    id: "permission-review",
    title: "工具权限审核",
    description: "批准只作用于当前工具调用；展开后可用 ↑↓ 滚动",
    contentHeight: visibleLines,
    actions: actions(),
    input: {
      keypress: (key) => {
        if (!expanded) return
        if (key.name === "up") scrollOffset = Math.max(0, scrollOffset - 1)
        if (key.name === "down") scrollOffset += 1
        render()
      },
    },
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
