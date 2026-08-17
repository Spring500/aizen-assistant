---
title: 安装与运行
type: guide
module: core
sort: 2
---

# 安装与运行

## 安装分发版本

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/Spring500/aizen-assistant/main/install.sh | bash
```

Windows（PowerShell）：

```powershell
iex ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/Spring500/aizen-assistant/main/install.ps1'))
```

国内网络可改用 jsDelivr 镜像脚本（可选）：

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/Spring500/aizen-assistant@main/install.sh | bash
```

安装到 `~/.aizen/`（Windows 为 `%USERPROFILE%\.aizen`），目录结构如下：

- `bin/aizen-assistant`：启动入口（launcher），读取 `install.json` 的当前版本并注入数据目录后启动真实程序；
- `versions/vX.Y.Z/`：各版本的真实可执行文件，安装与更新时新增版本目录，运行中的实例不被替换；
- `data/`：数据目录，固定于安装根，升级不迁移；
- `install.json`：安装来源记录（channel / version / platform / current）。

只修改用户级环境（`~/.aizen`、shell 配置、用户 PATH），全程无需管理员权限；重复执行安全。需要指定历史版本时：macOS/Linux 用 `bash install.sh 0.1.0`，Windows 下载脚本后 `powershell -ExecutionPolicy Bypass -File install.ps1 0.1.0`。

当前提供官方安装包的平台：**Windows x64、Linux x64、macOS（Apple Silicon）**。Windows ARM64、Linux ARM64 与 Intel Mac（darwin-x64）暂不支持，安装脚本检测到这些平台时会明确提示，不会返回 404。

**更新**：运行 `aizen-assistant update`，自动从 GitHub Releases 下载最新版并落位到新的版本目录，随后切换 `install.json` 的当前版本指向。新版本与运行中的实例互不干扰，**更新可在实例运行中完成**，下次启动即用新版本；历史版本保留最近一个供回滚。

**卸载**：运行 `aizen-assistant uninstall`，确认后删除 `~/.aizen` 并回滚 PATH。

**macOS 提示**：未签名的发布版首次运行可能被 Gatekeeper 拦截，请右键点击打开，或在终端对真实可执行文件执行：

```bash
xattr -d com.apple.quarantine ~/.aizen/versions/v*/aizen-assistant
```

## 环境准备（源码开发）

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

该命令直接运行 TypeScript 源码，不编译可执行文件，也不会自动重启。无论从 worktree 内哪个目录执行，工作目录均为 worktree 根目录，默认数据目录为 `<worktree>/.aizen`。

需要隔离开发数据时，可以指定其它目录：

```powershell
bun run dev:tui --data-dir .aizen-other
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

产物位于 `dist/`（Windows 为 `aizen-assistant.exe`，其余平台为 `aizen-assistant`），运行时不要求另行安装 Node.js 或 Bun。直接运行产物（便携模式）时默认数据目录为可执行文件同目录的 `.aizen`，也可以显式指定；受管安装的数据目录由启动入口注入到 `~/.aizen/data/`：

```powershell
.\dist\aizen-assistant.exe --data-dir <目录>
```

数据目录的具体内容与备份建议见[数据存储](./data-storage.md)。
