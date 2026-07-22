# AizenAssistant

AizenAssistant 是基于 pi SDK 构建的 AI Agent 应用。项目以无界面的 TypeScript 核心为基础，同时建设自研 TUI 与 Tauri/Vue 桌面 GUI，并支持每轮临时上下文注入和视图式提示词组织。

项目当前处于初始化阶段，尚未开始代码脚手架与架构可行性验证实施。

## 本地开发

```powershell
bun install --frozen-lockfile
bun run hooks:install
bun run verify
```

协作和 PR 规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目文档

- [AI Agent 行为指令](AGENTS.md)
- [汇报指南](TALK_GUIDE.md)

## 当前技术方向

- Bun workspace 与 TypeScript 核心
- pi SDK adapter
- OpenTUI 自研终端界面
- Vue + Vite + Tauri 桌面界面
- Windows x64 首发，用户环境无需 Node/Bun

具体实现必须先通过设计文档定义的架构可行性验证。
