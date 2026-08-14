import { expect } from "bun:test"
import type { CliRenderer } from "@opentui/core"
import { initThemeSync } from "../../packages/tui-kit/renderer.ts"
import { darkThemeColors, getSystemColors, lightThemeColors, setSystemColors } from "../../packages/tui-kit/theme.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

/** 构造最小可用 renderer mock（含 raw stdout 写入通道与事件订阅）。 */
function createMockRenderer(themeMode: string | null): {
  renderer: CliRenderer
  writes: string[]
  themeModeListeners: Array<(mode: string) => void>
} {
  const writes: string[] = []
  const themeModeListeners: Array<(mode: string) => void> = []
  const renderer = {
    themeMode,
    stdout: {},
    realStdoutWrite: (chunk: unknown) => writes.push(String(chunk)),
    on: (_event: string, cb: (mode: string) => void) => {
      themeModeListeners.push(cb)
    },
    off: () => {},
  } as unknown as CliRenderer
  return { renderer, writes, themeModeListeners }
}

test("initThemeSync 主动发送 CSI ?997n 配色模式查询", () => {
  const { renderer, writes } = createMockRenderer(null)
  const unsubscribe = initThemeSync(renderer, () => {})
  expect(writes).toContain("\x1b[?997n")
  unsubscribe()
})

test("initThemeSync 应用已就绪的 themeMode", () => {
  const { renderer } = createMockRenderer("light")
  const changed: string[] = []
  try {
    setSystemColors("dark")
    const unsubscribe = initThemeSync(renderer, (mode) => changed.push(mode))
    expect(changed).toEqual(["light"])
    expect(getSystemColors()).toBe(lightThemeColors)
    unsubscribe()
  } finally {
    setSystemColors("dark")
  }
})

test("initThemeSync 通过 THEME_MODE 事件切换色板", () => {
  const { renderer, themeModeListeners } = createMockRenderer(null)
  const changed: string[] = []
  try {
    setSystemColors("dark")
    const unsubscribe = initThemeSync(renderer, (mode) => changed.push(mode))
    // 模拟 OpenTUI 收到 997 响应后触发的亮暗切换事件。
    themeModeListeners[0]?.("light")
    expect(changed).toEqual(["light"])
    expect(getSystemColors()).toBe(lightThemeColors)
    unsubscribe()
  } finally {
    setSystemColors("dark")
  }
})

test("initThemeSync 同一模式重复应用不回调", () => {
  const { renderer } = createMockRenderer("dark")
  const changed: string[] = []
  try {
    setSystemColors("dark")
    const unsubscribe = initThemeSync(renderer, (mode) => changed.push(mode))
    expect(changed).toEqual([])
    expect(getSystemColors()).toBe(darkThemeColors)
    unsubscribe()
  } finally {
    setSystemColors("dark")
  }
})
