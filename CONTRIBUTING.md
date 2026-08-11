# 参与开发

本项目当前由单人配合 AI Agent 开发。所有变更从最新 `main` 创建短生命周期分支，并通过 Draft PR 交付。

## 环境准备

项目使用 Bun workspace，Bun 版本见 `.bun-version` 和 `package.json`。

```powershell
bun install --frozen-lockfile
```

安装依赖时会自动配置仓库的 Git hooks。

## 启动 TUI

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

## 构建与运行

构建单文件可执行程序（默认 Windows x64）：

```powershell
bun run build:tui
```

需要其它平台时通过 `--target` 指定（如 `bun run build:tui --target bun-linux-x64`）。产物位于 `dist/aizen-assistant.exe`（Windows；其余平台为 `dist/aizen-assistant`），运行时不要求另行安装 Node.js 或 Bun。默认数据目录为可执行文件同目录的 `data`，也可以显式指定：

```powershell
.\dist\aizen-assistant.exe --data-dir <目录>
```

## 检查与测试

提交前运行完整验证：

```powershell
bun run verify
```

完整验证依次执行：

- 仓库配置检查；
- 格式检查；
- 静态检查；
- TypeScript 类型检查；
- TUI 与 pi HTTP 探针构建；
- 自动测试；
- Windows x64 单文件运行验证。

开发过程中也可以单独运行：

```powershell
bun run format
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run check:config
```

## 分支与 PR

1. 切换到 `main`，执行 `git pull --ff-only`。
2. 创建 `feat/*`、`fix/*`、`chore/*`、`docs/*`、`build/*`、`ci/*` 或 `spike/*` 分支。
3. 完成修改并执行 `bun run verify`。
4. 推送分支并创建 Draft PR。
5. 由项目负责人审查、转为 Ready，并使用 Squash merge。

功能分支内部提交不强制 Conventional Commits；PR 标题和 Squash 后的主线提交必须符合仓库标题校验规则。

## 主分支与文件边界

禁止日常直接 push、force push 或删除 `main`。当前仓库没有服务端分支保护，Git hooks 只能防止误操作，不能代替人工检查。

设计、方案和实施计划保存在被忽略的本地私有目录，禁止加入 Git。凭证、会话、日志和构建产物同样禁止提交。
