---
title: 快速开始
type: guide
module: core
sort: 1
---

# 快速开始

AizenAssistant 提供两种启动方式：**从源码启动**（面向开发与体验最新功能）与**安装启动**（面向普通用户）。

## 从源码启动

项目使用 Bun workspace。安装锁定依赖并启动 TUI：

```powershell
bun install --frozen-lockfile
bun run dev:tui
```

`bun run dev:tui` 直接运行 TypeScript 源码，不编译可执行文件，也不会自动重启。无论从 worktree 内哪个目录执行，工作目录均为 worktree 根目录。

详细的环境准备、开发命令与构建方式见[安装与运行](./installation.md)。

## 安装启动

安装到 `~/.aizen/bin/`，只修改用户级环境，无需管理员权限；支持 Windows x64、Linux x64、macOS（Apple Silicon）。

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Spring500/aizen-assistant/main/install.sh | bash
```

```powershell
# Windows（PowerShell）
iex ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/Spring500/aizen-assistant/main/install.ps1'))
```

安装后直接运行 `aizen-assistant` 启动；`aizen-assistant update` 更新到最新版本，`aizen-assistant uninstall` 卸载并回滚 PATH。
