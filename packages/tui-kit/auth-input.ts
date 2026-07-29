import type { CliRenderer } from "@opentui/core"
import { editInline } from "./inline-input.ts"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"

export type AuthInputOptions = {
  mask?: boolean
  signal?: AbortSignal
  onCancel?: () => void
}

/**
 * 在认证页面内显示原生行内输入；页面标题与说明在编辑期间保持可见。
 */
export function promptAuthInput(
  manager: OverlayManager | CliRenderer,
  id: string,
  title: string,
  label: string,
  options: AuthInputOptions = {},
): Promise<string | undefined> {
  const overlays = overlayManager(manager)
  return new Promise((resolve) => {
    let settled = false
    const handle = overlays.open<string>({
      id,
      title,
      description: options.mask ? "输入内容仅以遮盖字符显示" : "输入认证信息",
      actions: [],
      contentHeight: 2,
      ...(options.signal ? { signal: options.signal } : {}),
      onCancel: () => finish(undefined, true),
    })
    const finish = (value: string | undefined, cancelled = false) => {
      if (settled) return
      settled = true
      handle.close(value)
      if (cancelled) options.onCancel?.()
      resolve(value)
    }
    void editInline(overlays, handle, {
      id: `${id}-field`,
      label,
      initialValue: "",
      ...(options.mask === undefined ? {} : { mask: options.mask }),
      top: 0,
    }).then((value) => finish(value, value === undefined))
  })
}
