import { expect } from "bun:test"
import {
  blockColors,
  darkThemeColors,
  getSystemColors,
  lightThemeColors,
  setSystemColors,
  systemColors,
} from "../../packages/tui-kit/theme.ts"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

test("默认使用深色色板，blockColors 与其一致", () => {
  expect(systemColors).toBe(darkThemeColors)
  expect(getSystemColors()).toBe(darkThemeColors)
  expect(blockColors.assistant).toBe(darkThemeColors.bgAssistant)
  expect(blockColors.tool).toBe(darkThemeColors.bgTool)
})

test("setSystemColors 切换色板并同步 blockColors", () => {
  try {
    expect(setSystemColors("light")).toBe(true)
    expect(systemColors).toBe(lightThemeColors)
    expect(getSystemColors()).toBe(lightThemeColors)
    expect(blockColors.assistant).toBe(lightThemeColors.bgAssistant)
    expect(blockColors.tool).toBe(lightThemeColors.bgTool)
    // 同一模式重复切换不产生变化。
    expect(setSystemColors("light")).toBe(false)
    // 切回深色。
    expect(setSystemColors("dark")).toBe(true)
    expect(systemColors).toBe(darkThemeColors)
  } finally {
    setSystemColors("dark")
  }
})

test("深浅两套色板 token 齐全且取值不同", () => {
  const darkKeys = Object.keys(darkThemeColors)
  const lightKeys = Object.keys(lightThemeColors)
  expect(darkKeys.sort()).toEqual(lightKeys.sort())
  for (const key of darkKeys) {
    const token = key as keyof typeof darkThemeColors
    expect(darkThemeColors[token]).not.toBe(lightThemeColors[token])
  }
})
