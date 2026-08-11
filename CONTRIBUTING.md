# 参与开发

感谢你对 AizenAssistant 的兴趣。本文说明如何本地开发、验证变更并提交 PR。日常使用方法见[文档站](docs/zh/index.md)。

## 反馈问题

遇到问题或有改进建议，请先通过 GitHub Issue 反馈，说明复现步骤与环境信息。功能改动请先通过 Issue 讨论方案，避免返工。

## 环境准备

项目使用 Bun workspace，Bun 版本见 `.bun-version` 和 `package.json`。

```powershell
bun install --frozen-lockfile
```

安装依赖时会自动配置仓库的 Git hooks。本地开发运行方式见[文档站：安装与运行](docs/zh/core/installation.md)。

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

## 文档与 wiki

仓库 `docs/` 目录是文档站的源内容，通过 GitHub Pages 对外发布：

- 所有对外文档位于 `docs/zh/`，按模块内聚（如 `docs/zh/permission/`）；
- 每篇文档头部需标注 frontmatter（`title`、`type`、`module`、`sort`），侧边栏由此自动生成，勿手工维护；
- 修改对外文档后，运行 `bun run docs:build` 确认构建通过；
- 内部工作文档（TODO、交接记录等）放入 `internal/`，不对外发布；
- 敏感内容（设计草案、PR 交接等）放入被忽略的本地私有目录，禁止提交。

## 主分支与文件边界

禁止日常直接 push、force push 或删除 `main`。当前仓库没有服务端分支保护，Git hooks 只能防止误操作，不能代替人工检查。

设计、方案和实施计划保存在被忽略的本地私有目录，禁止加入 Git。凭证、会话、日志和构建产物同样禁止提交。
