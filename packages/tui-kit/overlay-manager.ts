import {
  BoxRenderable,
  type CliRenderer,
  CliRenderEvents,
  type KeyEvent,
  type PasteEvent,
  type Renderable,
  TextRenderable,
} from "@opentui/core"
import { systemColors } from "./theme.ts"

export type OverlayInput = {
  keypress?: (key: KeyEvent) => void
  paste?: (event: PasteEvent) => void
}

export type OverlayOptions = {
  id: string
  title: string
  help?: string
  contentHeight: number
  signal?: AbortSignal
  onCancel?: () => void
  input?: OverlayInput
}

export interface OverlayHandle<T = unknown> {
  readonly id: string
  readonly container: BoxRenderable
  readonly content: BoxRenderable
  readonly signal: AbortSignal
  close(result?: T): void
  suspend(): void
  resume(): void
  setInput(input: OverlayInput): void
  setContentHeight(height: number): void
}

type OverlayLayer = {
  id: string
  container: BoxRenderable
  content: BoxRenderable
  title: TextRenderable
  help: TextRenderable
  controller: AbortController
  input: OverlayInput
  contentHeight: number
  suspended: boolean
  previousFocus: Renderable | null
  externalSignal?: AbortSignal
  externalAbort?: () => void
  onCancel?: () => void
}

const managers = new WeakMap<CliRenderer, OverlayManager>()

export function overlayManager(value: OverlayManager | CliRenderer): OverlayManager {
  if (value instanceof OverlayManager) return value
  const existing = managers.get(value)
  if (existing) return existing
  const created = new OverlayManager(value)
  managers.set(value, created)
  return created
}

export class OverlayManager {
  private readonly stack: OverlayLayer[] = []
  private baseFooterHeight: number
  private disposed = false

  constructor(
    readonly renderer: CliRenderer,
    private onCtrlC?: () => void,
  ) {
    this.baseFooterHeight = renderer.footerHeight
    renderer.keyInput.prependListener("keypress", this.routeKeypress)
    renderer.keyInput.prependListener("paste", this.routePaste)
    renderer.on(CliRenderEvents.RESIZE, this.layout)
    renderer.once(CliRenderEvents.DESTROY, this.dispose)
  }

  get depth(): number {
    return this.stack.length
  }

  setCtrlCHandler(handler: () => void): void {
    this.onCtrlC = handler
  }

  setBaseFooterHeight(height: number): void {
    this.baseFooterHeight = Math.max(1, height)
    if (this.stack.length > 0) this.layout()
    else if (this.renderer.screenMode === "split-footer") this.renderer.footerHeight = this.baseFooterHeight
  }

  open<T = unknown>(options: OverlayOptions): OverlayHandle<T> {
    if (this.disposed) throw new Error("OverlayManager 已销毁")
    const parent = this.stack.at(-1)
    if (parent) parent.suspended = true

    const container = new BoxRenderable(this.renderer, {
      id: `${options.id}-overlay`,
      position: "absolute",
      overflow: "hidden",
      backgroundColor: "#111827",
      shouldFill: true,
      zIndex: 1000 + this.stack.length,
    })
    const title = new TextRenderable(this.renderer, {
      id: `${options.id}-title`,
      position: "absolute",
      height: 1,
      wrapMode: "none",
      truncate: true,
      fg: systemColors.header,
      content: options.title,
    })
    const content = new BoxRenderable(this.renderer, {
      id: options.id,
      position: "absolute",
      overflow: "hidden",
      shouldFill: true,
      backgroundColor: "#111827",
    })
    const help = new TextRenderable(this.renderer, {
      id: `${options.id}-help`,
      position: "absolute",
      height: 1,
      wrapMode: "none",
      truncate: true,
      fg: systemColors.shortcuts,
      content: options.help ?? "",
    })
    container.add(title)
    container.add(content)
    container.add(help)
    this.renderer.root.add(container)

    const layer: OverlayLayer = {
      id: options.id,
      container,
      content,
      title,
      help,
      controller: new AbortController(),
      input: options.input ?? {},
      contentHeight: Math.max(1, options.contentHeight),
      suspended: false,
      previousFocus: this.renderer.currentFocusedRenderable,
      ...(options.onCancel ? { onCancel: options.onCancel } : {}),
      ...(options.signal ? { externalSignal: options.signal } : {}),
    }
    this.stack.push(layer)
    if (options.signal) {
      layer.externalAbort = () => this.closeLayer(layer, undefined, true)
      if (options.signal.aborted) queueMicrotask(layer.externalAbort)
      else options.signal.addEventListener("abort", layer.externalAbort, { once: true })
    }
    this.layout()

    return {
      id: layer.id,
      container,
      content,
      signal: layer.controller.signal,
      close: (result?: T) => this.closeLayer(layer, result, false),
      suspend: () => {
        layer.suspended = true
      },
      resume: () => {
        if (this.stack.at(-1) === layer) layer.suspended = false
      },
      setInput: (input) => {
        layer.input = input
      },
      setContentHeight: (height) => {
        layer.contentHeight = Math.max(1, height)
        this.layout()
      },
    }
  }

  closeAll(): void {
    for (const layer of [...this.stack].reverse()) this.closeLayer(layer, undefined, true)
  }

  dispose = (): void => {
    if (this.disposed) return
    this.closeAll()
    this.disposed = true
    this.renderer.keyInput.off("keypress", this.routeKeypress)
    this.renderer.keyInput.off("paste", this.routePaste)
    this.renderer.off(CliRenderEvents.RESIZE, this.layout)
  }

  private readonly routeKeypress = (key: KeyEvent): void => {
    const layer = this.stack.at(-1)
    if (!layer || layer.suspended) return
    key.preventDefault()
    key.stopPropagation()
    if (key.ctrl && key.name === "c") {
      this.onCtrlC?.()
      this.closeAll()
      return
    }
    layer.input.keypress?.(key)
  }

  private readonly routePaste = (event: PasteEvent): void => {
    const layer = this.stack.at(-1)
    if (!layer || layer.suspended) return
    event.preventDefault()
    event.stopPropagation()
    layer.input.paste?.(event)
  }

  private readonly layout = (): void => {
    if (this.stack.length === 0 || this.disposed) return
    const terminalHeight = Math.max(3, this.renderer.terminalHeight)
    const required = Math.max(this.baseFooterHeight, ...this.stack.map((layer) => layer.contentHeight + 2))
    const footerHeight = Math.min(terminalHeight, required)
    if (this.renderer.screenMode === "split-footer") this.renderer.footerHeight = footerHeight
    const width = Math.max(1, this.renderer.terminalWidth)
    for (const [index, layer] of this.stack.entries()) {
      layer.container.left = 0
      layer.container.top = 0
      layer.container.width = width
      layer.container.height = footerHeight
      layer.container.zIndex = 1000 + index
      layer.title.left = 1
      layer.title.right = 1
      layer.title.top = 0
      layer.content.left = 1
      layer.content.right = 1
      layer.content.top = 1
      layer.content.height = Math.max(1, footerHeight - 2)
      layer.help.left = 1
      layer.help.right = 1
      layer.help.top = Math.max(1, footerHeight - 1)
    }
  }

  private closeLayer(layer: OverlayLayer, _result: unknown, cancelled: boolean): void {
    const index = this.stack.indexOf(layer)
    if (index < 0) return
    this.stack.splice(index, 1)
    if (layer.externalSignal && layer.externalAbort)
      layer.externalSignal.removeEventListener("abort", layer.externalAbort)
    layer.controller.abort()
    layer.container.destroyRecursively()
    if (cancelled) layer.onCancel?.()

    const top = this.stack.at(-1)
    if (top) {
      top.suspended = false
      const focus = top.previousFocus
      if (focus && !focus.isDestroyed) focus.focus()
      this.layout()
    } else {
      if (this.renderer.screenMode === "split-footer") this.renderer.footerHeight = this.baseFooterHeight
      const focus = layer.previousFocus
      if (focus && !focus.isDestroyed) focus.focus()
    }
  }
}
