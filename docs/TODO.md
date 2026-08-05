# 项目 TODO

本文统一记录项目中已经确认但尚未完成的工作。新增待办应按业务领域归入对应二级章节；每项待办需要说明现状、追溯依据、后续工作和验收标准，完成后从本文移除。

## CI 稳定性

### Windows 独占句柄测试在等待 holder 就绪时偶发超时

#### 现状

`tests/core/session-index-store.test.ts` 的“Windows独占句柄下验证读取、替换和旧索引完整性”曾多次在等待 PowerShell holder 写入 ready 前后超时。最近一次有完整状态的失败发生在 CI Run `30899175785`：

- Bun 已成功创建 holder，PID 为 `1172`，超时时进程仍存活；
- holder 脚本和目标索引存在；
- ready、release 均不存在；
- 没有出现 holder 的第一条 `script-started` 日志。

现有证据把故障范围缩小到 `Bun.spawn` 返回后、PowerShell 脚本第一条语句执行前；尚不能区分 PowerShell 启动或脚本加载阻塞、进程状态观测问题及更底层的系统等待。

#### 追溯

```powershell
gh run view 30899175785 --repo Spring500/aizen-assistant --log
gh api repos/Spring500/aizen-assistant/actions/runs/30899175785/jobs
```

更早的同类记录：

- Run `30626426610`，Attempt 3，Job `91143472968`；
- Run `30677032216`，Attempt 1，Job `91306335828`。

#### 已有诊断能力

- holder 通过 stdout 记录脚本进入、打开句柄前后、写入 ready、观察 release 和释放句柄。
- 统一测试超时入口会输出 Bun 运行时、已注册进程和文件路径状态。
- 本测试超时时采集 Bun 与 PowerShell holder 的轻量转储；CI 失败产物保留七天。
- 竞态修复后的 CI Run `30923223527` 连续执行 10 个 Attempt，未再次出现该超时，但这不足以关闭未定位问题。

#### 待办

- [ ] 等待 ready 时同时观察 `holder.exited`；若子进程提前退出，应立即报告退出码。
- [ ] 清理时先请求 holder 退出并有界等待；必要时终止进程，确认退出后再删除临时目录。
- [ ] 获得下一次超时转储后分析线程栈，确认 PowerShell 停留在进程启动、脚本加载、`File.Open` 还是其他系统等待。
- [ ] 根据新证据修复根因；不得仅通过放宽超时掩盖问题。

#### 验收标准

- 超时时能从日志和转储直接判断故障阶段，且不产生未处理清理错误或遗留进程。
- 根因修复后，Windows CI 连续运行 100 次无同类失败。
- 完整 `bun run verify` 与分发验证继续通过。
