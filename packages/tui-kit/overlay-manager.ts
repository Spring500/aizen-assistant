import {
  BoxRenderable,
  type CliRenderer,
  CliRenderEvents,
  createTextAttributes,
  type KeyEvent,
  type PasteEvent,
  parseColor,
  type Renderable,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core"
import { systemColors } from "./theme.ts"

export type OverlayInput = {
  keypress?: (key: KeyEvent) => void
  paste?: (event: PasteEvent) => void
}

export type OverlayActionKey = {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
}

export type OverlayAction = {
  id: string
  key: OverlayActionKey
  alternateKeys?: OverlayActionKey[]
  label: string
  applicable?: boolean
  enabled?: boolean
  disabledReason?: string
  priority?: number
  run(key: KeyEvent): void
}

export type OverlayOptions = {
  id: string
  title: string
  description?: string
  help?: string
  error?: string
  actions?: OverlayAction[]
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
  setDescription(description: string): void
  setActions(actions: OverlayAction[]): void
  setError(error: string): void
  clearError(): void
  /** 兼容旧调用；后续页面迁移后删除。 */
  setHelp(help: string): void
}

type OverlayLayer = {
  id: string
  container: BoxRenderable
  content: BoxRenderable
  title: TextRenderable
  description: TextRenderable
  shortcuts: TextRenderable
  error: TextRenderable
  controller: AbortController
  input: OverlayInput
  actions: OverlayAction[]
  defaultDescription: string
  currentDescription: string
  contentHeight: number
  descriptionHeight: number
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

function keyMatches(event: KeyEvent, expected: OverlayActionKey): boolean {
  return (
    event.name === expected.name &&
    !!event.ctrl === !!expected.ctrl &&
    !!event.shift === !!expected.shift &&
    !!event.meta === !!expected.meta
  )
}

function wrapToCells(value: string, width: number, maxLines = 3): string[] {
  if (!value) return [""]
  const safeWidth = Math.max(1, width)
  const lines: string[] = []
  let current = ""
  const push = () => {
    lines.push(current)
    current = ""
  }
  for (const character of value) {
    if (character === "\n") {
      push()
    } else if (Bun.stringWidth(current + character) > safeWidth) {
      push()
      current = character
    } else current += character
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && (current || lines.length === 0)) lines.push(current)
  if (lines.length === maxLines && Bun.stringWidth(lines[maxLines - 1] ?? "") >= safeWidth) {
    const last = lines[maxLines - 1] ?? ""
    let truncated = ""
    for (const character of last) {
      if (Bun.stringWidth(`${truncated}${character}…`) > safeWidth) break
      truncated += character
    }
    lines[maxLines - 1] = `${truncated}…`
  }
  return lines.slice(0, maxLines)
}

function shortcutContent(actions: OverlayAction[], fallback: string): string | StyledText {
  const visible = actions
    .filter((action) => action.applicable !== false)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  if (visible.length === 0) return fallback
  const chunks: TextChunk[] = []
  for (const [index, action] of visible.entries()) {
    if (index > 0) chunks.push({ __isChunk: true, text: " | ", fg: parseColor(systemColors.shortcuts) })
    chunks.push({
      __isChunk: true,
      text: action.label,
      fg: parseColor(action.enabled === false ? systemColors.disabled : systemColors.shortcuts),
      attributes: createTextAttributes({ dim: action.enabled === false }),
    })
  }
  return new StyledText(chunks)
}

export class OverlayManager {
  private readonly stack: OverlayLayer[] = []
  private baseFooterHeight: number
  private pendingError = ""
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

  /** 将错误写入当前页面的错误说明行。 */
  setCurrentError(error: string): boolean {
    if (this.stack.length === 0) {
      this.pendingError = error
      return true
    }
    for (const layer of this.stack) layer.error.content = error
    return true
  }

  /** 清除当前页面的错误说明。 */
  clearCurrentError(): void {
    const layer = this.stack.at(-1)
    if (layer) layer.error.content = ""
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
    const description = new TextRenderable(this.renderer, {
      id: `${options.id}-description`,
      position: "absolute",
      height: 1,
      wrapMode: "none",
      truncate: true,
      fg: systemColors.secondary,
      content: options.description ?? "",
    })
    const shortcuts = new TextRenderable(this.renderer, {
      id: `${options.id}-shortcuts`,
      position: "absolute",
      height: 1,
      wrapMode: "none",
      truncate: true,
      fg: systemColors.shortcuts,
      content: shortcutContent(options.actions ?? [], options.help ?? ""),
    })
    const error = new TextRenderable(this.renderer, {
      id: `${options.id}-error`,
      position: "absolute",
      height: 1,
      wrapMode: "none",
      truncate: true,
      fg: systemColors.statusError,
      content: options.error ?? this.pendingError,
    })
    container.add(title)
    container.add(content)
    container.add(description)
    container.add(shortcuts)
    container.add(error)
    this.renderer.root.add(container)

    const layer: OverlayLayer = {
      id: options.id,
      container,
      content,
      title,
      description,
      shortcuts,
      error,
      controller: new AbortController(),
      input: options.input ?? {},
      actions: options.actions ?? [],
      defaultDescription: options.description ?? "",
      currentDescription: options.description ?? "",
      contentHeight: Math.max(1, options.contentHeight),
      descriptionHeight: 1,
      suspended: false,
      previousFocus: this.renderer.currentFocusedRenderable,
      ...(options.onCancel ? { onCancel: options.onCancel } : {}),
      ...(options.signal ? { externalSignal: options.signal } : {}),
    }
    this.stack.push(layer)
    this.pendingError = ""
    if (options.signal) {
      layer.externalAbort = () => this.closeLayer(layer, true)
      if (options.signal.aborted) queueMicrotask(layer.externalAbort)
      else options.signal.addEventListener("abort", layer.externalAbort, { once: true })
    }
    this.layout()

    const setDescription = (value: string) => {
      layer.defaultDescription = value
      layer.currentDescription = value
      this.layout()
    }
    return {
      id: layer.id,
      container,
      content,
      signal: layer.controller.signal,
      close: (_result?: T) => this.closeLayer(layer, false),
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
      setDescription,
      setActions: (actions) => {
        layer.actions = actions
        layer.shortcuts.content = shortcutContent(actions, "")
      },
      setError: (value) => {
        layer.error.content = value
      },
      clearError: () => {
        layer.error.content = ""
      },
      setHelp: (help) => {
        layer.shortcuts.content = help
      },
    }
  }

  closeAll(): void {
    for (const layer of [...this.stack].reverse()) this.closeLayer(layer, true)
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
    const action = layer.actions.find(
      (candidate) =>
        candidate.applicable !== false &&
        (keyMatches(key, candidate.key) || candidate.alternateKeys?.some((expected) => keyMatches(key, expected))),
    )
    if (action) {
      if (action.enabled === false) {
        layer.currentDescription = action.disabledReason ?? "当前操作不可用"
        this.layout()
      } else {
        layer.currentDescription = layer.defaultDescription
        this.layout()
        action.run(key)
      }
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
    const width = Math.max(1, this.renderer.terminalWidth)
    for (const layer of this.stack) {
      const lines = wrapToCells(layer.currentDescription, Math.max(1, width - 2))
      layer.descriptionHeight = Math.max(1, lines.length)
      layer.description.content = lines.join("\n")
      layer.description.height = layer.descriptionHeight
    }
    const terminalHeight = Math.max(5, this.renderer.terminalHeight)
    const required = Math.max(
      this.baseFooterHeight,
      ...this.stack.map((layer) => layer.contentHeight + layer.descriptionHeight + 3),
    )
    const footerHeight = Math.min(terminalHeight, required)
    if (this.renderer.screenMode === "split-footer") this.renderer.footerHeight = footerHeight
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
      layer.content.height = Math.max(1, footerHeight - layer.descriptionHeight - 3)
      layer.description.left = 1
      layer.description.right = 1
      layer.description.top = Math.max(1, footerHeight - layer.descriptionHeight - 2)
      layer.shortcuts.left = 1
      layer.shortcuts.right = 1
      layer.shortcuts.top = Math.max(1, footerHeight - 2)
      layer.error.left = 1
      layer.error.right = 1
      layer.error.top = Math.max(1, footerHeight - 1)
    }
  }

  private closeLayer(layer: OverlayLayer, cancelled: boolean): void {
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
