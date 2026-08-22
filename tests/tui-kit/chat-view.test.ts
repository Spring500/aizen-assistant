import { expect } from "bun:test"
import { createDiagnosticTest } from "../utils/diagnostic-test.ts"
import { parseColor, TextAttributes, type CliRenderer, type OptimizedBuffer } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { defaultAppPreferences } from "../../packages/core/app-preferences-store.ts"
import type { CoreSnapshot } from "../../packages/core/types.ts"
import { createChatView, formatDurationText } from "../../packages/tui-kit/chat-view.ts"
import { statusBarView } from "../../packages/tui-kit/status-bar.ts"
import {
  blockColors,
  darkThemeColors,
  lightThemeColors,
  setSystemColors,
  systemColors,
} from "../../packages/tui-kit/theme.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

function snapshot(overrides: Partial<CoreSnapshot> = {}): CoreSnapshot {
  return {
    cwd: "E:\\project",
    status: "idle",
    sessions: [],
    models: [],
    preferences: structuredClone(defaultAppPreferences),
    views: [],
    authProviders: [],
    transcript: [],
    transcriptRevision: 0,
    historyTurns: [],
    activeTools: [],
    streamingText: "",
    streamingThinking: "",
    ...overrides,
  }
}

type QueuedCommit = { snapshot: OptimizedBuffer }

type CapturedSpan = {
  text: string
  fg: ReturnType<OptimizedBuffer["getSpanLines"]>[number]["spans"][number]["fg"]
  bg: ReturnType<OptimizedBuffer["getSpanLines"]>[number]["spans"][number]["bg"]
  attributes: number
}

function takeScrollbackSpans(renderer: CliRenderer): CapturedSpan[] {
  const queue = Reflect.get(renderer, "externalOutputQueue") as { claim(): QueuedCommit[] }
  const commits = queue.claim()
  try {
    return commits.flatMap((commit) =>
      commit.snapshot
        .getSpanLines()
        .flatMap((line) => line.spans)
        .map((span) => ({ text: span.text.trim(), fg: span.fg, bg: span.bg, attributes: span.attributes }))
        .filter((span) => span.text),
    )
  } finally {
    for (const commit of commits) commit.snapshot.destroy()
  }
}

function spanByText(spans: CapturedSpan[], text: string): CapturedSpan {
  const span = spans.find((item) => item.text === text)
  if (!span) throw new Error(`未找到终端样式片段：${text}`)
  return span
}

async function setupRepl(width = 100, height = 20) {
  return createTestRenderer({
    width,
    height,
    screenMode: "split-footer",
    footerHeight: 9,
    externalOutputMode: "capture-stdout",
  })
}

test("销毁会等待排队更新并拒绝后续写入", async () => {
  const setup = await setupRepl()
  const view = createChatView(setup.renderer)
  try {
    const updating = view.update(
      snapshot({
        transcript: [
          {
            type: "input",
            turnId: "closing",
            items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "关闭前更新" }] }],
          },
        ],
      }),
    )
    setup.renderer.resize(80, 20)
    const destroying = view.destroy()

    await expect(Promise.all([updating, destroying])).resolves.toBeDefined()
    await expect(view.update(snapshot({ streamingText: "关闭后更新" }))).resolves.toBeUndefined()
    await expect(view.destroy()).resolves.toBeUndefined()
    await Bun.sleep(100)
  } finally {
    setup.renderer.destroy()
  }
})

test("状态栏视图模型根据运行状态生成统一内容", () => {
  const current = snapshot({
    status: "running",
    currentSessionId: "s1",
    currentModel: { providerId: "test", modelId: "model", thinkingLevel: "off", contextWindow: 1000 },
    contextUsage: { used: 250, total: 1000 },
  })
  const view = statusBarView(current)
  expect(
    typeof view.session === "string" ? view.session : view.session.chunks.map((chunk) => chunk.text).join(""),
  ).toContain("权限：编辑·完全人工")
  expect(view.shortcuts).toBe("Esc 中止 | Ctrl+C 退出")
})

test("聊天视图把历史写入原生 scrollback", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    await view.update(
      snapshot({
        status: "running",
        currentModel: {
          providerId: "test",
          modelId: "model",
          thinkingLevel: "off",
        },
        transcript: [
          {
            type: "input",
            turnId: "t1",
            items: [
              {
                source: "user",
                role: "user",
                useLater: true,
                parts: [{ kind: "text", text: "hello" }],
              },
            ],
          },
        ],
      }),
    )
    await setup.renderOnce()
    const history = setup.externalOutput.takeText().replace(/\s+/g, "")
    expect(history).toContain("hello")
  } finally {
    setup.renderer.destroy()
  }
})

test("聊天视图展示工作目录变化", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    await view.update(
      snapshot({
        transcript: [
          {
            type: "environment",
            recordId: "cwd-change",
            text: 'Working directory changed from "E:\\old" to "D:\\new".',
          },
        ],
      }),
    )
    await setup.renderOnce()
    expect(setup.externalOutput.takeText()).toContain('Working directory changed from "E:\\old" to "D:\\new".')
  } finally {
    setup.renderer.destroy()
  }
})

test("聊天视图展示上下文压缩摘要", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    await view.update(
      snapshot({
        transcriptRevision: 1,
        transcript: [
          {
            type: "compaction_summary",
            recordId: "compact-1",
            summary: "## 当前目标\n\n保留关键决策",
            tokensBefore: 120000,
          },
        ],
      }),
    )
    await setup.renderOnce()
    const output = setup.externalOutput.takeText().replace(/\s+/g, "")
    expect(output).toContain("上下文压缩摘要·压缩前120000tokens")
    expect(output).toContain("当前目标")
    expect(output).toContain("保留关键决策")
  } finally {
    setup.renderer.destroy()
  }
})

test("完成的助手正文按 Markdown 格式写入历史", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    await view.update(
      snapshot({
        preferences: structuredClone(defaultAppPreferences),
        transcript: [
          {
            type: "message",
            turnId: "markdown-turn",
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "text",
                  text: [
                    "# 一级标题",
                    "",
                    "## 二级标题",
                    "",
                    "### 三级标题",
                    "",
                    "#### 四级标题",
                    "",
                    "##### 五级标题",
                    "",
                    "###### 六级标题",
                    "",
                    "这是 **重点**，包含 `行内代码`。",
                    "",
                    "```ts",
                    "const answer: number = 42",
                    "```",
                    "",
                    "行内公式 $E = mc^2$。",
                    "",
                    "$$",
                    "\\sum_{i=0}^{n} x_i",
                    "$$",
                  ].join("\n"),
                },
              ],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "stop",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
        ],
      }),
    )
    const spans = takeScrollbackSpans(setup.renderer)
    const history = spans.map((span) => span.text).join("")
    const rgba = (hex: string) => [...parseColor(hex).toInts()] as [number, number, number, number]
    const headingExpectations = [
      ["一级标题", rgba(systemColors.mdHeading1)],
      ["二级标题", rgba(systemColors.mdHeading2)],
      ["三级标题", rgba(systemColors.mdHeading3)],
      ["四级标题", rgba(systemColors.mdHeading4)],
      ["五级标题", rgba(systemColors.mdHeading5)],
      ["六级标题", rgba(systemColors.mdHeading6)],
    ] as const
    const strong = spanByText(spans, "重点")
    const keyword = spanByText(spans, "const")
    const codeType = spanByText(spans, "number")
    const codeNumber = spanByText(spans, "42")
    const inlineFormula = spanByText(spans, "E = mc²")
    const blockFormula = spanByText(spans, "∑ᵢ₌₀ⁿ xᵢ")

    for (const [text, color] of headingExpectations) {
      const heading = spanByText(spans, text)
      expect(heading.fg.toInts()).toEqual([...color])
      expect(heading.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
    }
    expect(strong.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
    expect(keyword.fg.toInts()).toEqual(rgba(systemColors.syntaxKeyword))
    expect(keyword.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
    expect(codeType.fg.toInts()).toEqual(rgba(systemColors.syntaxType))
    expect(codeNumber.fg.toInts()).toEqual(rgba(systemColors.syntaxNumber))
    expect(keyword.bg.toInts()).toEqual(rgba(blockColors.tool))
    expect(inlineFormula.fg.toInts()).toEqual(rgba(systemColors.mdInlineCode))
    expect(blockFormula.fg.toInts()).toEqual(rgba(systemColors.mdFormula))
    expect(blockFormula.bg.toInts()).toEqual(rgba(blockColors.tool))
    expect(history).not.toContain("#一级标题")
    expect(history).not.toContain("**重点**")
    expect(history).not.toContain("`行内代码`")
    expect(history).not.toContain("```ts")
    expect(history).not.toContain("$E = mc^2$")
    expect(history).not.toContain("$$")
    await view.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("历史块包含同底色的上下留白并记录思考内容", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    await view.update(
      snapshot({
        preferences: {
          ...structuredClone(defaultAppPreferences),
          fold: { ...defaultAppPreferences.fold, thinkingExpanded: true },
        },
        transcript: [
          {
            type: "message",
            turnId: "thinking-turn",
            message: {
              role: "assistant",
              parts: [{ kind: "thinking", text: "内部分析内容", signature: "sig" }],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "stop",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
        ],
      }),
    )
    await setup.renderOnce()
    const output = setup.externalOutput.takeText()
    expect(output).toContain("▼ 思考")
    expect(output.replace(/\r?\n/g, "")).toContain("内部分析内容")
    await view.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("resize 会按新宽度全量回放历史", async () => {
  const setup = await setupRepl(80, 20)
  try {
    const view = createChatView(setup.renderer)
    await view.update(
      snapshot({
        transcript: [
          {
            type: "input",
            turnId: "resize-turn",
            items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "resize 内容" }] }],
          },
        ],
      }),
    )
    await setup.renderOnce()
    setup.externalOutput.takeText()
    setup.renderer.resize(40, 20)
    await Bun.sleep(100)
    await setup.renderOnce()
    expect(setup.externalOutput.takeText()).toContain("resize 内容")
    await view.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("终端配色切换后全量重放使用新色板", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    await view.update(
      snapshot({
        transcript: [
          {
            type: "message",
            turnId: "theme-turn",
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "text",
                  text: [
                    "# 一级标题",
                    "",
                    "## 二级标题",
                    "",
                    "### 三级标题",
                    "",
                    "#### 四级标题",
                    "",
                    "##### 五级标题",
                    "",
                    "###### 六级标题",
                    "",
                    "这是 **重点**。",
                  ].join("\n"),
                },
              ],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "stop",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
        ],
      }),
    )
    // update 与 refreshTheme 的提交入队即完成，无需 renderOnce（其会 flush 并丢弃队列中的 commit）。
    const darkSpans = takeScrollbackSpans(setup.renderer)
    expect(spanByText(darkSpans, "一级标题").fg.toInts()).toEqual([...parseColor(darkThemeColors.mdHeading1).toInts()])
    expect(spanByText(darkSpans, "一级标题").bg.toInts()).toEqual([...parseColor(darkThemeColors.bgAssistant).toInts()])
    setSystemColors("light")
    try {
      await view.refreshTheme()
      const lightSpans = takeScrollbackSpans(setup.renderer)
      expect(spanByText(lightSpans, "一级标题").fg.toInts()).toEqual([
        ...parseColor(lightThemeColors.mdHeading1).toInts(),
      ])
      expect(spanByText(lightSpans, "一级标题").bg.toInts()).toEqual([
        ...parseColor(lightThemeColors.bgAssistant).toInts(),
      ])
    } finally {
      setSystemColors("dark")
    }
    await view.destroy()
  } finally {
    setup.renderer.destroy()
  }
})

test("工具组和工具详情分别由布尔开关控制", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    const transcript: CoreSnapshot["transcript"] = [
      {
        type: "message",
        turnId: "tools",
        message: {
          role: "assistant",
          parts: [
            {
              kind: "tool_call",
              callId: "c1",
              name: "bash",
              arguments: { command: "bun test" },
              declaredIntent: "运行测试",
            },
          ],
          source: { providerId: "test", modelId: "model", api: "a" },
          stopReason: "tool_use",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      },
      {
        type: "message",
        turnId: "tools",
        message: {
          role: "tool",
          callId: "c1",
          name: "bash",
          parts: [{ kind: "text", text: "all passed" }],
          isError: false,
        },
      },
      { type: "turn_end", turnId: "tools", outcome: "completed" },
    ]
    await view.update(
      snapshot({
        preferences: {
          ...structuredClone(defaultAppPreferences),
          fold: { thinkingExpanded: false, toolGroupExpanded: false, toolDetailsExpanded: true },
        },
        transcript,
      }),
    )
    await setup.renderOnce()
    const collapsed = setup.externalOutput.takeText().replace(/\s+/g, "")
    expect(collapsed).toContain("▶1个工具调用：bash")
    expect(collapsed).not.toContain("运行测试")

    await view.update(
      snapshot({
        preferences: {
          ...structuredClone(defaultAppPreferences),
          fold: { thinkingExpanded: false, toolGroupExpanded: true, toolDetailsExpanded: false },
        },
        transcript,
      }),
    )
    await setup.renderOnce()
    const summary = setup.externalOutput.takeText().replace(/\s+/g, "")
    expect(summary).toContain("▼1个工具调用：bash")
    expect(summary).toContain("[bash]运行测试")
    expect(summary).not.toContain("buntest")
    expect(summary).not.toContain("allpassed")
  } finally {
    setup.renderer.destroy()
  }
})

test("组展开但详情折叠时失败工具行仍显示失败标记", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    await view.update(
      snapshot({
        preferences: {
          ...structuredClone(defaultAppPreferences),
          fold: { thinkingExpanded: false, toolGroupExpanded: true, toolDetailsExpanded: false },
        },
        transcript: [
          {
            type: "message",
            turnId: "tools",
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "tool_call",
                  callId: "c1",
                  name: "bash",
                  arguments: { command: "bun test" },
                  declaredIntent: "运行测试",
                },
              ],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "tool_use",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
          {
            type: "message",
            turnId: "tools",
            message: {
              role: "tool",
              callId: "c1",
              name: "bash",
              parts: [{ kind: "text", text: "bun: command not found" }],
              isError: true,
            },
          },
          { type: "turn_end", turnId: "tools", outcome: "completed" },
        ],
      }),
    )
    await setup.renderOnce()
    const summary = setup.externalOutput.takeText().replace(/\s+/g, "")
    // 组展开、详情折叠：失败标记可见，但详细输出仍隐藏。
    expect(summary).toContain("▼1个工具调用：bash")
    expect(summary).toContain("[bash]运行测试")
    expect(summary).toContain("×")
    expect(summary).not.toContain("bun:commandnotfound")
  } finally {
    setup.renderer.destroy()
  }
})

test("同一轮内工具随思考/对话段边界分批归档为独立组块", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    await view.update(
      snapshot({
        preferences: {
          ...structuredClone(defaultAppPreferences),
          fold: { thinkingExpanded: true, toolGroupExpanded: true, toolDetailsExpanded: true },
        },
        transcript: [
          {
            type: "message",
            turnId: "tools",
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "tool_call",
                  callId: "c1",
                  name: "bash",
                  arguments: { command: "bun test" },
                  declaredIntent: "运行测试",
                },
              ],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "tool_use",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
          {
            type: "message",
            turnId: "tools",
            message: {
              role: "tool",
              callId: "c1",
              name: "bash",
              parts: [{ kind: "text", text: "first" }],
              isError: false,
            },
          },
          {
            type: "message",
            turnId: "tools",
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "tool_call",
                  callId: "c2",
                  name: "bash",
                  arguments: { command: "bun run typecheck" },
                  declaredIntent: "检查类型",
                },
              ],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "tool_use",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
          {
            type: "message",
            turnId: "tools",
            message: {
              role: "tool",
              callId: "c2",
              name: "bash",
              parts: [{ kind: "text", text: "second" }],
              isError: false,
            },
          },
          { type: "turn_end", turnId: "tools", outcome: "completed" },
          {
            type: "input",
            turnId: "recent",
            items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "下一轮" }] }],
          },
        ],
      }),
    )
    await setup.renderOnce()
    const output = setup.externalOutput.takeText().replace(/\s+/g, "")
    // 工具随思考/对话段边界分批归档：c1 在 M2 段边界、c2 在 turn_end 兜底，各自独立组块。
    expect(output.match(/个工具调用/g)).toHaveLength(2)
    expect(output).toContain("[bash]运行测试")
    expect(output).toContain("[bash]检查类型")
    expect(output).toContain("first")
    expect(output).toContain("second")
    // 两个组块均位于下一轮输入之前。
    expect(output.indexOf("下一轮")).toBeGreaterThan(output.lastIndexOf("个工具调用"))
  } finally {
    setup.renderer.destroy()
  }
})

test("耗时格式覆盖天时分秒", () => {
  expect(formatDurationText(0)).toBe("0s")
  expect(formatDurationText(62_000)).toBe("1m 2s")
  expect(formatDurationText(93_784_000)).toBe("1d 2h 3m 4s")
})

test("历史没有变化时不重复写入 scrollback", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    const current = snapshot({
      preferences: {
        ...structuredClone(defaultAppPreferences),
        fold: { thinkingExpanded: false, toolGroupExpanded: true, toolDetailsExpanded: true },
      },
      transcript: [
        {
          type: "input",
          turnId: "old",
          items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "旧轮次用户消息" }] }],
        },
        {
          type: "message",
          turnId: "old",
          message: {
            role: "assistant",
            parts: [{ kind: "text", text: "旧轮次助手正文" }],
            source: { providerId: "test", modelId: "model", api: "a" },
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
        },
        {
          type: "input",
          turnId: "recent",
          items: [{ source: "user", role: "user", useLater: true, parts: [{ kind: "text", text: "最近用户消息" }] }],
        },
        {
          type: "message",
          turnId: "recent",
          message: {
            role: "assistant",
            parts: [
              { kind: "thinking", text: "最近思考", timing: { startedAt: 1000, finishedAt: 3000 } },
              {
                kind: "tool_call",
                callId: "c1",
                name: "bash",
                arguments: { command: "bun test" },
                declaredIntent: "验证全部测试是否通过",
              },
            ],
            source: { providerId: "test", modelId: "model", api: "a" },
            stopReason: "tool_use",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
        },
        {
          type: "message",
          turnId: "recent",
          message: {
            role: "tool",
            callId: "c1",
            name: "bash",
            parts: [{ kind: "text", text: "all passed" }],
            isError: false,
            timing: { startedAt: 3000, finishedAt: 65000 },
          },
        },
        { type: "turn_end", turnId: "recent", outcome: "completed" },
      ],
    })
    await view.update(current)
    await setup.renderOnce()
    const firstOutput = setup.externalOutput.takeText().replace(/\s+/g, "")
    expect(firstOutput).toContain("[你]旧轮次用户消息")
    expect(firstOutput).toContain("旧轮次助手正文")
    expect(firstOutput).toContain("▶思考最近思考")
    expect(firstOutput).toContain("[bash]验证全部测试是否通过")
    expect(firstOutput).toContain("›buntest")
    expect(firstOutput).toContain("✓allpassed")
    expect(firstOutput).toContain("1m2s")
    expect(firstOutput).toContain("allpassed")

    await view.update({ ...current, status: "running", streamingText: "working" })
    await setup.renderOnce()
    expect(setup.externalOutput.take()).toHaveLength(0)
  } finally {
    setup.renderer.destroy()
  }
})

test("工具调用进行中不生成历史块，轮次结束统一归档", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    const foldPref = {
      ...structuredClone(defaultAppPreferences),
      fold: { thinkingExpanded: false, toolGroupExpanded: true, toolDetailsExpanded: true },
    }
    const running = snapshot({
      preferences: foldPref,
      transcript: [
        {
          type: "message",
          turnId: "t1",
          message: {
            role: "assistant",
            parts: [
              {
                kind: "tool_call",
                callId: "c1",
                name: "bash",
                arguments: { command: "bun test" },
                declaredIntent: "运行测试",
              },
            ],
            source: { providerId: "test", modelId: "model", api: "a" },
            stopReason: "tool_use",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
    })
    // 轮次进行中：历史不生成工具块（由 footer 输出区展示）。
    await view.update(running)
    await setup.renderOnce()
    expect(setup.externalOutput.takeText()).not.toContain("bun test")

    // 轮次结束（completed）：本轮工具统一归档为一个组块。
    await view.update(
      snapshot({
        preferences: foldPref,
        transcript: [
          ...(running.transcript as NonNullable<typeof running.transcript>),
          {
            type: "message",
            turnId: "t1",
            message: {
              role: "tool",
              callId: "c1",
              name: "bash",
              parts: [{ kind: "text", text: "all passed" }],
              isError: false,
            },
          },
          { type: "turn_end", turnId: "t1", outcome: "completed" },
        ],
      }),
    )
    await setup.renderOnce()
    const history = setup.externalOutput.takeText().replace(/\s+/g, "")
    expect(history).toContain("[bash]运行测试")
    expect(history).toContain("✓allpassed")
  } finally {
    setup.renderer.destroy()
  }
})

test("工具完成越过思考/对话段边界即分批归档，全程追加不重放", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    const foldPref = {
      ...structuredClone(defaultAppPreferences),
      fold: { thinkingExpanded: false, toolGroupExpanded: true, toolDetailsExpanded: true },
    }
    const m1: CoreSnapshot["transcript"][number] = {
      type: "message",
      turnId: "t1",
      message: {
        role: "assistant",
        parts: [
          {
            kind: "tool_call",
            callId: "c1",
            name: "bash",
            arguments: { command: "bun test" },
            declaredIntent: "运行测试",
          },
        ],
        source: { providerId: "test", modelId: "model", api: "a" },
        stopReason: "tool_use",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    }
    const r1: CoreSnapshot["transcript"][number] = {
      type: "message",
      turnId: "t1",
      message: {
        role: "tool",
        callId: "c1",
        name: "bash",
        parts: [{ kind: "text", text: "first done" }],
        isError: false,
      },
    }
    const m2: CoreSnapshot["transcript"][number] = {
      type: "message",
      turnId: "t1",
      message: {
        role: "assistant",
        parts: [
          {
            kind: "tool_call",
            callId: "c2",
            name: "bash",
            arguments: { command: "bun run typecheck" },
            declaredIntent: "检查类型",
          },
        ],
        source: { providerId: "test", modelId: "model", api: "a" },
        stopReason: "tool_use",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    }
    const r2: CoreSnapshot["transcript"][number] = {
      type: "message",
      turnId: "t1",
      message: {
        role: "tool",
        callId: "c2",
        name: "bash",
        parts: [{ kind: "text", text: "second done" }],
        isError: false,
      },
    }
    const turnEnd: CoreSnapshot["transcript"][number] = { type: "turn_end", turnId: "t1", outcome: "completed" }
    const render = async (transcript: CoreSnapshot["transcript"]) => {
      await view.update(snapshot({ preferences: foldPref, transcript }))
      await setup.renderOnce()
      return setup.externalOutput.takeText().replace(/\s+/g, "")
    }

    // 进行中（无结果）：历史不生成工具块。
    expect(await render([m1])).toBe("")
    // 结果已到达但思考/对话段边界未到：仍不上屏。
    expect(await render([m1, r1])).toBe("")
    // 下一条助手消息（段边界）到达：c1 先归档上屏（追加），c2 仍在进行中不出现。
    const first = await render([m1, r1, m2])
    expect(first).toContain("[bash]运行测试")
    expect(first).toContain("firstdone")
    expect(first).not.toContain("检查类型")
    // c2 结果到达但无段边界：无新增。
    expect(await render([m1, r1, m2, r2])).toBe("")
    // 轮次结束：c2 兜底归档（追加）。
    const second = await render([m1, r1, m2, r2, turnEnd])
    expect(second).toContain("检查类型")
    expect(second).toContain("seconddone")
  } finally {
    setup.renderer.destroy()
  }
})

test("轮次中止时未响应的工具调用兜底归档", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    await view.update(
      snapshot({
        preferences: {
          ...structuredClone(defaultAppPreferences),
          fold: { thinkingExpanded: false, toolGroupExpanded: true, toolDetailsExpanded: true },
        },
        transcript: [
          {
            type: "message",
            turnId: "t1",
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "tool_call",
                  callId: "c1",
                  name: "bash",
                  arguments: { command: "bun test" },
                  declaredIntent: "运行测试",
                },
              ],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "tool_use",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
          { type: "turn_end", turnId: "t1", outcome: "aborted" },
        ],
      }),
    )
    await setup.renderOnce()
    const history = setup.externalOutput.takeText().replace(/\s+/g, "")
    expect(history).toContain("未响应（本轮已中止/失败）")
    expect(history).toContain("[已中止]")
  } finally {
    setup.renderer.destroy()
  }
})

test("崩溃恢复的悬空工具以失败组块归档显示", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    // 对应 core 的 recoverInterruptedToolCalls 恢复结果：补中断说明结果 + turn_end(failed)。
    await view.update(
      snapshot({
        preferences: {
          ...structuredClone(defaultAppPreferences),
          fold: { thinkingExpanded: false, toolGroupExpanded: true, toolDetailsExpanded: true },
        },
        transcript: [
          {
            type: "message",
            turnId: "t1",
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "tool_call",
                  callId: "c1",
                  name: "bash",
                  arguments: { command: "bun test" },
                  declaredIntent: "运行测试",
                },
              ],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "tool_use",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
          {
            type: "message",
            turnId: "t1",
            message: {
              role: "tool",
              callId: "c1",
              name: "bash",
              parts: [{ kind: "text", text: "Operation interrupted: The application stopped before execution." }],
              isError: true,
            },
          },
          { type: "turn_end", turnId: "t1", outcome: "failed" },
        ],
      }),
    )
    await setup.renderOnce()
    const history = setup.externalOutput.takeText().replace(/\s+/g, "")
    expect(history).toContain("1个工具调用")
    expect(history).toContain("Operationinterrupted")
    expect(history).toContain("[执行失败]")
  } finally {
    setup.renderer.destroy()
  }
})

test("最终回复到达时工具组块即归档，且位于回复之前", async () => {
  const setup = await setupRepl()
  try {
    const view = createChatView(setup.renderer)
    await view.update(
      snapshot({
        preferences: {
          ...structuredClone(defaultAppPreferences),
          fold: { thinkingExpanded: false, toolGroupExpanded: true, toolDetailsExpanded: true },
        },
        transcript: [
          {
            type: "message",
            turnId: "t1",
            message: {
              role: "assistant",
              parts: [
                {
                  kind: "tool_call",
                  callId: "c1",
                  name: "bash",
                  arguments: { command: "bun test" },
                  declaredIntent: "运行测试",
                },
              ],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "tool_use",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
          {
            type: "message",
            turnId: "t1",
            message: {
              role: "tool",
              callId: "c1",
              name: "bash",
              parts: [{ kind: "text", text: "all passed" }],
              isError: false,
            },
          },
          {
            type: "message",
            turnId: "t1",
            message: {
              role: "assistant",
              parts: [{ kind: "text", text: "最终回复内容" }],
              source: { providerId: "test", modelId: "model", api: "a" },
              stopReason: "stop",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          },
          // 不依赖 turn_end：归档由无新工具调用的最终回复消息触发。
        ],
      }),
    )
    await setup.renderOnce()
    const output = setup.externalOutput.takeText().replace(/\s+/g, "")
    const toolIndex = output.indexOf("个工具调用")
    const replyIndex = output.indexOf("最终回复内容")
    expect(toolIndex).toBeGreaterThan(-1)
    expect(replyIndex).toBeGreaterThan(toolIndex)
  } finally {
    setup.renderer.destroy()
  }
})
