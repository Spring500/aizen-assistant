import { type CliRenderer, TextRenderable } from "@opentui/core"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"
import { systemColors } from "./theme.ts"

export type CycleRow = {
  kind: "cycle"
  /** 动态标签：循环切换后会重新读取当前值。 */
  label: () => string
  /** 动态提示：说明当前值的实际效果。 */
  hint: () => string
  cycle: (direction: 1 | -1) => Promise<void>
}

export type ActionRow = {
  kind: "action"
  label: () => string
  hint: () => string
  /** 返回 true 表示关闭菜单；抛错会交给 onError 显示。 */
  action: () => Promise<boolean>
}

export type CycleMenuRow = CycleRow | ActionRow

export type CycleMenuOptions = {
  title: string
  rows: CycleMenuRow[]
  signal?: AbortSignal
  onError: (kind: "cycle" | "action", message: string) => Promise<void> | void
}

const maximumRows = 12

/**
 * 停留在页面内的循环/动作菜单：↑↓ 移动、←/→ 循环切换、Enter 执行动作、Esc 返回。
 * 动作执行后菜单保持打开且光标不动，只有 action 返回 true（或 Esc）才关闭。
 */
export function cycleMenu(manager: OverlayManager | CliRenderer, id: string, options: CycleMenuOptions): Promise<void> {
  const overlays = overlayManager(manager)
  return new Promise<void>((resolve) => {
    let settled = false
    let selected = 0
    let offset = 0
    const finish = () => {
      if (settled) return
      settled = true
      handle.close()
      resolve()
    }
    const handle = overlays.open({
      id,
      title: options.title,
      description: "",
      actions: [],
      contentHeight: options.rows.length,
      ...(options.signal ? { signal: options.signal } : {}),
      onCancel: finish,
    })
    const rowRenderables = Array.from(
      { length: maximumRows },
      (_, index) =>
        new TextRenderable(overlays.renderer, {
          id: `${id}-row-${index}`,
          position: "absolute",
          top: index,
          left: 0,
          right: 0,
          height: 1,
          wrapMode: "none",
          truncate: true,
          fg: systemColors.secondary,
          content: "",
        }),
    )
    for (const renderable of rowRenderables) handle.content.add(renderable)
    const visibleCount = () => {
      const available = Math.max(1, overlays.renderer.terminalHeight - 5)
      return Math.max(1, Math.min(options.rows.length, available))
    }
    const render = () => {
      const visible = visibleCount()
      if (selected < offset) offset = selected
      else if (selected >= offset + visible) offset = selected - visible + 1
      offset = Math.max(0, Math.min(offset, Math.max(0, options.rows.length - visible)))
      for (const [rowIndex, renderable] of rowRenderables.entries()) {
        const itemIndex = offset + rowIndex
        const item = options.rows[itemIndex]
        renderable.visible = rowIndex < visible && item !== undefined
        if (!item) continue
        renderable.fg = itemIndex === selected ? systemColors.header : systemColors.secondary
        renderable.content = `${itemIndex === selected ? "▶ " : "  "}${item.label()}`
      }
      const current = options.rows[selected]
      handle.setDescription(current ? `${current.label()}　${current.hint()}` : "")
      updateActions()
    }
    const move = (delta: number) => {
      selected = Math.max(0, Math.min(options.rows.length - 1, selected + delta))
      render()
    }
    const runSelected = async () => {
      const row = options.rows[selected]
      if (row?.kind !== "action") return
      try {
        if (await row.action()) finish()
      } catch (error) {
        await options.onError("action", error instanceof Error ? error.message : String(error))
      }
    }
    const cycleSelected = async (direction: 1 | -1) => {
      const row = options.rows[selected]
      if (row?.kind !== "cycle") return
      try {
        await row.cycle(direction)
        render()
      } catch (error) {
        await options.onError("cycle", error instanceof Error ? error.message : String(error))
      }
    }
    /** 快捷键提示只对当前行有意义的操作显示。 */
    const updateActions = () => {
      const isCycle = options.rows[selected]?.kind === "cycle"
      const isAction = options.rows[selected]?.kind === "action"
      handle.setActions([
        {
          id: "move",
          key: { name: "up" },
          alternateKeys: [{ name: "down" }],
          label: "↑↓ 选择",
          run: (key) => move(key.name === "up" ? -1 : 1),
        },
        {
          id: "cycle",
          key: { name: "left" },
          alternateKeys: [{ name: "right" }],
          label: "←/→ 切换",
          applicable: isCycle,
          run: (key) => void cycleSelected(key.name === "left" ? -1 : 1),
        },
        {
          id: "select",
          key: { name: "return" },
          label: "Enter 执行",
          applicable: isAction,
          run: () => void runSelected(),
        },
        { id: "cancel", key: { name: "escape" }, label: "Esc 返回", run: finish },
      ])
    }
    render()
  })
}
