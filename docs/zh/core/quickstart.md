---
title: 快速开始
type: guide
module: core
sort: 1
---

# 快速开始

项目使用 Bun workspace。安装锁定依赖并启动 TUI：

```powershell
bun install --frozen-lockfile
bun run dev:tui
```

`bun run dev:tui` 直接运行 TypeScript 源码，不编译可执行文件，也不会自动重启。无论从 worktree 内哪个目录执行，工作目录均为 worktree 根目录。

详细的环境准备、开发命令与构建方式见[安装与运行](./installation.md)。
