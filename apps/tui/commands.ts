export type TuiCommandName =
  | "/quit"
  | "/new"
  | "/sessions"
  | "/rewind"
  | "/fork"
  | "/rename"
  | "/compact"
  | "/views"
  | "/view"
  | "/fold"
  | "/model"
  | "/models"
  | "/agents"

export type TuiCommand = {
  name: TuiCommandName
  description: string
}

export const tuiCommands: readonly TuiCommand[] = [
  { name: "/new", description: "新建会话" },
  { name: "/sessions", description: "选择或管理会话" },
  { name: "/rewind", description: "回退到更早的用户消息" },
  { name: "/fork", description: "从用户消息创建会话副本" },
  { name: "/rename", description: "重命名当前会话" },
  { name: "/compact", description: "压缩当前会话，可附加摘要要求" },
  { name: "/view", description: "切换当前视图" },
  { name: "/views", description: "管理视图" },
  { name: "/model", description: "切换当前模型" },
  { name: "/models", description: "管理供应商和模型" },
  { name: "/agents", description: "设置内置 Agent" },
  { name: "/fold", description: "设置会话内容折叠开关" },
  { name: "/quit", description: "退出应用" },
]

export type ParsedTuiCommand = { name: TuiCommandName; argument?: string }

/** 解析完整 TUI 命令；重命名和压缩命令接受行内参数。 */
export function parseTuiCommand(value: string): ParsedTuiCommand | undefined {
  const normalized = value.trim()
  const argumentCommand = normalized.match(/^\/(rename|compact)(?:\s+(.+))?$/s)
  if (argumentCommand) {
    const argument = argumentCommand[2]?.trim()
    const name = `/${argumentCommand[1]}` as "/rename" | "/compact"
    return { name, ...(argument ? { argument } : {}) }
  }
  const command = tuiCommands.find((item) => item.name === normalized)
  return command ? { name: command.name } : undefined
}

/** 判断输入是否为已注册的完整 TUI 命令。 */
export function isTuiCommand(value: string): value is TuiCommandName {
  const parsed = parseTuiCommand(value)
  return parsed !== undefined && parsed.argument === undefined
}
