# 参与开发

本项目当前由单人配合 AI Agent 开发。所有变更从最新 `main` 创建短生命周期分支，并通过 Draft PR 交付。

## 基本流程

1. 执行 `git pull --ff-only` 更新 `main`。
2. 创建 `feat/*`、`fix/*`、`chore/*`、`docs/*`、`build/*`、`ci/*` 或 `spike/*` 分支。
3. 安装并验证：`bun install --frozen-lockfile`（自动安装 git hooks 并执行 `verify`）。
4. Agent 只能创建 Draft PR，不得转为 Ready、合并或发布。
5. 项目负责人审查后手动转为 Ready，并使用 Squash merge。

功能分支内部提交不强制 Conventional Commits；PR 标题和 Squash 后的主线提交必须符合项目标题校验规则。

## 主分支边界

禁止日常直接 push、force push 或删除 `main`。当前 GitHub 套餐无法对 Private 仓库启用服务端分支保护，仓库 hook 只能防止误操作，仓库所有者仍可使用 `--no-verify` 主动绕过。

设计、方案和实施计划保存在被忽略的本地私有目录，禁止加入 Git。凭证、会话、日志和构建产物同样禁止提交。
