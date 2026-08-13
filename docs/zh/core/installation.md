---
title: 安装与运行
type: guide
module: core
sort: 2
---

# 安装与运行

## 环境准备

项目使用 Bun workspace，Bun 版本见 `.bun-version` 和 `package.json`。

```powershell
bun install --frozen-lockfile
```

安装依赖时会自动配置仓库的 Git hooks。

## 启动 TUI（开发）

推荐使用开发命令：

```powershell
bun run dev:tui
```

该命令直接运行 TypeScript 源码，不编译可执行文件，也不会自动重启。无论从 worktree 内哪个目录执行，工作目录均为 worktree 根目录，默认数据目录为 `<worktree>/.aizen/dev-data`。

需要隔离开发数据时，可以指定其它目录：

```powershell
bun run dev:tui --data-dir .aizen/另一组数据
```

相对路径以 worktree 根目录为基准，数据目录不能直接指定为 worktree 根目录。

也可以直接运行入口：

```powershell
bun apps/tui/main.ts --data-dir <目录>
```

直接运行入口时必须指定 `--data-dir`，相对路径以执行命令时的当前目录为基准。

## 构建可执行程序

构建单文件可执行程序（默认 Windows x64）：

```powershell
bun run build:tui
```

需要其它平台时通过 `--target` 指定，例如：

```powershell
bun run build:tui --target bun-linux-x64
bun run build:tui --target bun-darwin-arm64
```

产物位于 `dist/`（Windows 为 `aizen-assistant.exe`，其余平台为 `aizen-assistant`），运行时不要求另行安装 Node.js 或 Bun。默认数据目录为可执行文件同目录的 `data`，也可以显式指定：

```powershell
.\dist\aizen-assistant.exe --data-dir <目录>
```

数据目录的具体内容与备份建议见[数据存储](./data-storage.md)。
