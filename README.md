# AizenAssistant

AizenAssistant 是一个面向重度 Coding Agent 用户的本地 Coding Agent 应用，适合长期维护项目、频繁切换任务方式，并希望对 Agent 上下文做定制化管理的开发者。

## 特性

- **视图式上下文**：将系统提示词、项目规则和 Skill 组织成独立"工作预设"，按任务切换，而非固定使用工作目录下的 `AGENTS.md` 与 Skill。详细说明见[视图式上下文](https://spring500.github.io/aizen-assistant/zh/core/views.html)。
- **全局技能管理**：通过 `/skills` 从任意 git 仓库引入符合 SKILL.md 规范的技能，跨视图全局生效。详细说明见[全局技能管理](https://spring500.github.io/aizen-assistant/zh/core/skills.html)。
- **显式意图声明**：Agent 在执行工具前用自然语言说明调用目的，让操作更易理解，并为未来的权限审核提供依据。

## 快速开始

### 从源码启动

```powershell
bun install --frozen-lockfile
bun run dev:tui
```

### 安装启动

安装包形式的启动方式尚未提供，将在后续版本补充。

## 项目状态

- 项目仍处于早期开发阶段，更新节奏有限。
- 当前提供 TUI 界面，GUI 尚在规划中。
- 暂时基于 [pi](https://github.com/earendil-works/pi) SDK 构建，后续考虑使用 `pi-ai` 并自行设计 Agent Loop。

## 文档与参与

- **使用文档**：<https://spring500.github.io/aizen-assistant/>
- **参与开发**：见 [CONTRIBUTING.md](CONTRIBUTING.md)
