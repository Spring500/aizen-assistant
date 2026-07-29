export type TuiCommandName =
  | "/quit"
  | "/new"
  | "/sessions"
  | "/rewind"
  | "/fork"
  | "/rename"
  | "/views"
  | "/view"
  | "/fold"
  | "/model"
  | "/models"

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
  { name: "/view", description: "切换当前视图" },
  { name: "/views", description: "管理视图" },
  { name: "/model", description: "切换当前模型" },
  { name: "/models", description: "管理供应商和模型" },
  { name: "/fold", description: "设置会话内容折叠范围" },
  { name: "/quit", description: "退出应用" },
]

/** 判断输入是否为已注册的完整 TUI 命令。 */
export function isTuiCommand(value: string): value is TuiCommandName {
  return tuiCommands.some((command) => command.name === value)
}
