import type { CliRenderer } from "@opentui/core"
import { selectEditableItem } from "./editable-selector.ts"
import { overlayManager, type OverlayManager } from "./overlay-manager.ts"
import { selectItem } from "./selector.ts"

export type ThinkingEditorValue = {
  disableThinkingLevel?: string
  thinkingLevels: string[]
  defaultThinkingLevel: string
}

async function editLevels(
  overlays: OverlayManager,
  initial: string[],
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const levels = [...initial]
  while (true) {
    const action = await selectEditableItem<string>(
      overlays,
      "thinking-level-editor",
      () => [
        ...levels.map((level, index) => ({
          name: `${index + 1}. ${level}`,
          description: "原地编辑档位名称",
          value: `level:${index}`,
          edit: {
            label: `${index + 1}. `,
            value: level,
            validate: (value: string) => (value.trim() ? undefined : "档位名称不能为空"),
            save: (value: string) => {
              levels[index] = value.trim()
            },
          },
        })),
        {
          name: `新增档位  ${levels.length} / 6`,
          description: levels.length >= 6 ? "已达到档位上限" : "新增思考档位",
          value: "add",
          disabled: levels.length >= 6,
          disabledReason: "已达到 6 个思考档位上限",
          edit: {
            label: "新增档位  ",
            value: "",
            validate: (value: string) => (value.trim() ? undefined : "档位名称不能为空"),
            save: (value: string) => {
              levels.push(value.trim())
            },
          },
        },
        { name: "调整顺序或删除", description: "移动或删除已有档位", value: "organize" },
        { name: "完成", description: "保存档位并返回", value: "done" },
      ],
      { title: "思考档位名", ...(signal ? { signal } : {}) },
    )
    if (!action) return undefined
    if (action === "done") return levels
    if (action !== "organize") continue

    const target = await selectItem<number>(
      overlays,
      "thinking-level-organize-target",
      levels.map((level, index) => ({ name: level, description: `第 ${index + 1} 个档位`, value: index })),
      { title: "选择要调整的档位", ...(signal ? { signal } : {}) },
    )
    if (target === undefined) continue
    const operation = await selectItem<"up" | "down" | "delete">(
      overlays,
      "thinking-level-organize-action",
      [
        {
          name: "上移",
          description: target === 0 ? "已经位于首位" : "向上移动一位",
          value: "up",
          disabled: target === 0,
          disabledReason: "已经位于首位",
        },
        {
          name: "下移",
          description: target === levels.length - 1 ? "已经位于末位" : "向下移动一位",
          value: "down",
          disabled: target === levels.length - 1,
          disabledReason: "已经位于末位",
        },
        {
          name: "删除",
          description: levels.length <= 1 ? "至少保留一个档位" : "删除当前档位",
          value: "delete",
          disabled: levels.length <= 1,
          disabledReason: "至少保留一个思考档位",
        },
      ],
      { title: `调整 ${levels[target]}`, ...(signal ? { signal } : {}) },
    )
    if (operation === "up" && target > 0)
      [levels[target - 1], levels[target]] = [levels[target] ?? "", levels[target - 1] ?? ""]
    else if (operation === "down" && target < levels.length - 1)
      [levels[target], levels[target + 1]] = [levels[target + 1] ?? "", levels[target] ?? ""]
    else if (operation === "delete" && levels.length > 1) levels.splice(target, 1)
  }
}

/** 显示统一的思考能力配置页面，并返回完整配置或清除意图。 */
export async function editThinkingConfiguration(
  manager: OverlayManager | CliRenderer,
  initial?: ThinkingEditorValue,
  signal?: AbortSignal,
): Promise<ThinkingEditorValue | undefined | null> {
  const overlays = overlayManager(manager)
  let supported = initial !== undefined
  let allowDisable = initial?.disableThinkingLevel !== undefined
  let disableThinkingLevel = initial?.disableThinkingLevel ?? "off"
  let thinkingLevels = [...(initial?.thinkingLevels ?? ["low", "medium", "high"])]
  let defaultThinkingLevel = initial?.defaultThinkingLevel ?? thinkingLevels[1] ?? thinkingLevels[0] ?? ""

  while (true) {
    const action = await selectEditableItem<"supported" | "allowDisable" | "levels" | "default" | "save">(
      overlays,
      "thinking-config-editor",
      () => [
        {
          name: `思考能力        ${supported ? "支持" : "不支持"}`,
          description: "切换模型是否支持思考",
          value: "supported",
        },
        {
          name: `允许关闭思考    ${supported && allowDisable ? "是" : "否"}`,
          description: supported ? "切换是否提供关闭档位" : "请先启用思考能力",
          value: "allowDisable",
          disabled: !supported,
          disabledReason: "请先启用思考能力",
        },
        {
          name: `关闭档位名      ${supported && allowDisable ? disableThinkingLevel : "—"}`,
          description: supported && allowDisable ? "原地编辑关闭档位名称" : "请先允许关闭思考",
          value: "save",
          disabled: !supported || !allowDisable,
          disabledReason: "请先允许关闭思考",
          edit: {
            label: "关闭档位名      ",
            value: disableThinkingLevel,
            validate: (value: string) => (value.trim() ? undefined : "关闭档位名不能为空"),
            save: (value: string) => {
              const previous = disableThinkingLevel
              disableThinkingLevel = value.trim()
              if (defaultThinkingLevel === previous) defaultThinkingLevel = disableThinkingLevel
            },
          },
        },
        {
          name: `思考档位名      ${supported ? thinkingLevels.join("、") : "—"}  ${thinkingLevels.length} / 6`,
          description: supported ? "编辑、排序或删除思考档位" : "请先启用思考能力",
          value: "levels",
          disabled: !supported,
          disabledReason: "请先启用思考能力",
        },
        {
          name: `默认档位        ${supported ? defaultThinkingLevel || "未设置" : "—"}`,
          description: supported ? "从合法档位中选择" : "请先启用思考能力",
          value: "default",
          disabled: !supported,
          disabledReason: "请先启用思考能力",
        },
        { name: "保存", description: supported ? "校验并返回模型编辑页" : "清除全部思考配置", value: "save" },
      ],
      { title: "编辑思考配置", ...(signal ? { signal } : {}) },
    )
    if (!action) return null
    if (action === "supported") {
      supported = !supported
      if (!supported) {
        allowDisable = false
        thinkingLevels = []
        defaultThinkingLevel = ""
      } else {
        thinkingLevels = ["low", "medium", "high"]
        defaultThinkingLevel = "medium"
      }
    } else if (action === "allowDisable") {
      allowDisable = !allowDisable
      if (!allowDisable && defaultThinkingLevel === disableThinkingLevel) defaultThinkingLevel = thinkingLevels[0] ?? ""
    } else if (action === "levels") {
      const edited = await editLevels(overlays, thinkingLevels, signal)
      if (edited) {
        thinkingLevels = edited
        const available = [...(allowDisable ? [disableThinkingLevel] : []), ...thinkingLevels]
        if (!available.includes(defaultThinkingLevel)) defaultThinkingLevel = thinkingLevels[0] ?? disableThinkingLevel
      }
    } else if (action === "default") {
      const available = [...(allowDisable ? [disableThinkingLevel] : []), ...thinkingLevels]
      const selected = await selectItem(
        overlays,
        "thinking-default",
        available.map((level) => ({
          name: level,
          description: level === disableThinkingLevel ? "关闭档位" : "思考档位",
          value: level,
        })),
        { title: "选择默认思考档位", ...(signal ? { signal } : {}) },
      )
      if (selected) defaultThinkingLevel = selected
    } else if (!supported) return undefined
    else
      return {
        ...(allowDisable ? { disableThinkingLevel } : {}),
        thinkingLevels,
        defaultThinkingLevel,
      }
  }
}
