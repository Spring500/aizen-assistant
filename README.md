# AizenAssistant

AizenAssistant 是基于 pi SDK 构建的 AI Agent 应用。项目以无界面的 TypeScript 核心为基础，同时建设自研 TUI 与 Tauri/Vue 桌面 GUI，并支持每轮额外消息和视图式提示词组织。

当前已完成架构可行性验证，并建立可保存和恢复会话的自研 TUI 基础。

## 本地开发

```powershell
bun install --frozen-lockfile
```

交互模式：

```powershell
bun run dev:tui
```

该命令直接运行 TypeScript 源码，不编译 exe，也不会自动重启。无论从 worktree 内哪个目录执行，工作目录均为
worktree 根目录，开发数据默认保存在 `<worktree>/.aizen/dev-data`。

需要隔离另一组开发数据时，可显式指定目录：

```powershell
bun run dev:tui --data-dir .aizen/另一组数据
```

相对路径以 worktree 根目录为基准；数据目录不能直接指定为 worktree 根目录。直接运行
`bun apps/tui/main.ts` 时必须传入 `--data-dir`，相对路径则以执行命令时的当前目录为基准。

编译后的 `aizen-tui.exe` 默认使用 exe 同目录的 `data`，也可通过 `--data-dir` 指定其它目录。`--plain`
是单次、无状态调用，不读写该目录。

协作和 PR 规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目文档

- [技术路线图](docs/AizenAssistant技术路线图.md)
- [AI Agent 行为指令](AGENTS.md)
- [汇报指南](TALK_GUIDE.md)

## 当前技术方向

- Bun workspace 与 TypeScript 核心
- pi SDK adapter
- OpenTUI 自研终端界面
- Vue + Vite + Tauri 桌面界面
- Windows x64 首发，用户环境无需 Node/Bun

具体实现必须先通过设计文档定义的架构可行性验证。
