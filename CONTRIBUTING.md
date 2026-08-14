# 参与开发

感谢你对 AizenAssistant 的兴趣。本文说明如何本地开发、验证变更并提交 PR。日常使用方法见[使用文档](https://spring500.github.io/aizen-assistant/)。

## 反馈问题

遇到问题或有改进建议，请先通过 GitHub Issue 反馈，说明复现步骤与环境信息。功能改动请先通过 Issue 讨论方案，避免返工。

## 环境准备

项目使用 Bun workspace，Bun 版本见 `.bun-version` 和 `package.json`。

```powershell
bun install --frozen-lockfile
```

安装依赖时会自动配置仓库的 Git hooks。本地开发运行方式见[安装与运行](https://spring500.github.io/aizen-assistant/zh/core/installation.html)。

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

## 发布流程

发布由推送版本 tag 自动触发：CI 校验 tag → 3 平台构建打包 → e2e 门禁 → 创建 Draft Release。人工只需核对资产与撰写版本说明。

1. 确认 `main` 为最新且验证通过：`git pull --ff-only`，本地 `bun run verify`。
2. 打版本 tag 并推送（tag 必须指向 `main` 上的提交，否则 CI 拒绝）：
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
3. 等待 release workflow 完成（`gh run list --workflow=release.yml` 查看进度），确认 verify-tag、e2e、三平台 build、release 全部成功。
4. 核对 Draft Release 资产：3 个平台 zip + SHA256SUMS（`gh release view vX.Y.Z`）。
5. 撰写版本说明：编辑 Draft Release 的 notes，覆盖变更目标、主要变更、兼容性影响与注意事项；首个正式版应从产品核心功能写起。
6. 发布：`gh release edit vX.Y.Z --draft=false`，并在 GitHub Releases 页核对正式展示。

注意：tag 一旦推送不可修改，只能删除重打；发布前务必核对资产与版本说明。

## 文档与 wiki

仓库 `docs/` 目录是对外文档的源内容，通过 GitHub Pages 对外发布：

- 所有对外文档位于 `docs/zh/`，按模块内聚（如 `docs/zh/permission/`）；
- 每篇文档头部需标注 frontmatter（`title`、`type`、`module`、`sort`），侧边栏由此自动生成，勿手工维护；
- 修改对外文档后，运行 `bun run docs:build` 确认构建通过；
- 内部工作文档（TODO、交接记录等）放入 `internal/`，不对外发布；
- 敏感内容（设计草案、PR 交接等）放入被忽略的本地私有目录，禁止提交。

## 主分支与文件边界

禁止日常直接 push、force push 或删除 `main`。当前仓库没有服务端分支保护，Git hooks 只能防止误操作，不能代替人工检查。

设计、方案和实施计划保存在被忽略的本地私有目录，禁止加入 Git。凭证、会话、日志和构建产物同样禁止提交。
