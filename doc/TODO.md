# TODO

## Bash 流式输出持久化

Bash 的 stdout/stderr 当前只在进程内流式显示，工具结束后才生成并保存最终结果。若应用崩溃、断电或被强制结束，Agent 恢复会话时只能知道工具已开始，无法获知中断前执行到哪里。

后续应将 Bash 输出片段增量写入可恢复存储，并在恢复时把已保存输出附加到 `Operation interrupted` 工具结果。实现时需控制写入频率与存储上限，保留 stdout/stderr 顺序，标明输出可能不完整，并处理敏感内容脱敏、会话回退、分支及临时文件清理。

## 视图与全局技能（已实现，待补充）

本期已实现视图行为配置（`config.json` 的 `projectSources` 与 `loadUserSkills`）、三层资源组装与全局技能管理（`/skills` 引入、发现、安装、更新、卸载）。剩余工作：

- **视图模板分享**：为"视图目录整体迁移"提供显式导入/导出流程，配合全局技能按需重新拉取。
- **Perforce workspace 根边界**：在 `projectSources` 中增加 Perforce 档，依赖 `p4` CLI 与服务端可达。
- **isomorphic-git 的 Bun/Windows 兼容性验证**：`git-fetch.ts` 使用 isomorphic-git 的 node http 适配器，需在真实分发环境确认 clone/fetch 行为。
