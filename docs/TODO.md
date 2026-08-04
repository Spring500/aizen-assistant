# 项目 TODO

本文统一记录项目中已经确认但尚未完成的工作。新增待办应按业务领域归入对应二级章节；每项待办需要说明现状、追溯依据、后续工作和验收标准，完成后从本文移除。

## CI 稳定性

本节记录 PR [#26](https://github.com/Spring500/aizen-assistant/pull/26) 性能实验期间观察到的两个既有偶发失败。两次失败均发生在主工作流 `.github/workflows/ci.yml` 的 `verify` Job，提交均为 `09f574c9621f4445f9c5cd197bf30ad92d573702`。该提交只修改工作流缓存、PR 标题检查及对应工作流测试，没有修改下述业务实现或测试。

这些问题尚未在本文对应 PR 中修复。后续处理应建立独立分支和 PR，并保留压力运行结果。

### 公共追溯方式

工作流运行：

- 运行页面：<https://github.com/Spring500/aizen-assistant/actions/runs/30626426610>
- 第一次尝试：<https://github.com/Spring500/aizen-assistant/actions/runs/30626426610/attempts/1>
- 第三次尝试：<https://github.com/Spring500/aizen-assistant/actions/runs/30626426610/attempts/3>
- 同一运行的第二次尝试成功，可作为对照。

使用 GitHub CLI 查看完整日志：

```powershell
gh run view 30626426610 --repo Spring500/aizen-assistant --attempt 1 --log
gh run view 30626426610 --repo Spring500/aizen-assistant --attempt 2 --log
gh run view 30626426610 --repo Spring500/aizen-assistant --attempt 3 --log
```

按作业 ID 下载未经 `gh run view` 重排的原始日志：

```powershell
gh api repos/Spring500/aizen-assistant/actions/jobs/91142653495/logs > attempt-1.log
gh api repos/Spring500/aizen-assistant/actions/jobs/91143009903/logs > attempt-2.log
gh api repos/Spring500/aizen-assistant/actions/jobs/91143472968/logs > attempt-3.log
```

查询每次尝试对应的作业 ID：

```powershell
gh api repos/Spring500/aizen-assistant/actions/runs/30626426610/attempts/1/jobs
gh api repos/Spring500/aizen-assistant/actions/runs/30626426610/attempts/2/jobs
gh api repos/Spring500/aizen-assistant/actions/runs/30626426610/attempts/3/jobs
```

GitHub 会按保留策略删除 Actions 日志。若届时上述记录不可用，应以运行 ID、尝试编号、作业 ID、提交 SHA 和本文摘录作为检索依据，不应把本地 `.private/` 中的临时日志提交到仓库。

### 真实 TUI 交互场景存在初始化与销毁竞态

#### 失败记录

- 工作流：`ci`
- 运行：`30626426610`
- 尝试：`1`
- 作业：`verify`，ID `91142653495`
- Runner：`windows-2025-vs2026`，镜像版本 `20260714.173.1`
- 失败测试：`tests/app/interactive-full-flow.test.ts` 中的“真实完整 TUI 交互场景”
- 失败子场景：`invalid-model`

子进程出现了两个连续症状：

1. `tests/app/interactive-scenario.ts:214` 在固定等待 20 ms 后断言界面包含“会话设置 · 新建会话”，实际帧仍是聊天页脚；
2. 断言失败进入清理后，OpenTUI 抛出 `TextBuffer is destroyed`。

关键调用栈：

```text
error: TextBuffer is destroyed
  at guard (...node_modules\@opentui\src\text-buffer.ts:42:67)
  at setStyledText (...node_modules\@opentui\src\text-buffer.ts:86:10)
  at updateTextBuffer (...node_modules\@opentui\src\renderables\Text.ts:49:21)
  at content (...node_modules\@opentui\src\renderables\Text.ts:80:12)
  at refreshFooter (packages\tui-kit\chat-view.ts:527:5)
  at <anonymous> (packages\tui-kit\chat-view.ts:544:7)
```

`chat-view.ts:544` 位于 resize 防抖计时器回调中。`ChatView.destroy()` 会清理已知的 `resizeTimer`、解绑 resize 监听器并销毁 `header`、`live`、`status`；本次日志证明仍存在一次计时器回调在可渲染对象销毁后执行。当前证据不能确定它是在 `destroy()` 前已经进入回调，还是销毁期间又产生了 resize 事件。

#### 已查结论

- 测试已将每个 TUI 场景放入独立子进程，并在同一测试中串行执行，因此不是五个场景互相并发使用 OpenTUI 原生后端。
- 初始页面断言只等待固定 20 ms，没有使用文件中已有的 `waitForText()`。在负载波动的托管 Runner 上，这不足以证明页面一定完成初始化。
- 清理顺序为：发送 `Ctrl+C`、等待 `runInteractiveApp()` 完成、销毁测试 renderer。应用内部会先退订核心事件，再清空动作队列并释放核心，最后销毁 overlay、editor 和 chat view。
- resize 回调在 75 ms 后执行；调用栈明确指向该回调，而不是核心订阅中的普通 `view.update()`。
- 同一提交的第二次尝试通过，完整 TUI 测试耗时 9.672 秒；最终无缓存工作流也通过，耗时 7.422 秒。因此问题具有时序敏感性，尚无证据表明缓存内容改变了运行行为。

#### 已修复

- `ChatView` 的 snapshot 更新、折叠更新和 resize 回放已进入同一操作队列。
- `destroy()` 已改为异步生命周期：先进入 closing、拒绝新操作并解绑 resize，再等待已启动操作，最后销毁 OpenTUI renderable 和 Markdown 样式资源。
- 应用退出会等待 `view.destroy()` 完成；footer 写入同时检查生命周期和 OpenTUI `isDestroyed` 状态。
- 已增加“更新进行中销毁、关闭后拒绝更新、重复销毁”的回归测试。

#### 待办

- [ ] 在 Windows CI 连续运行 10 次，确认不再出现 `TextBuffer is destroyed`。
- [ ] 若仍复现，保留对应 Run、Attempt 和完整调用栈并重新评估其他 OpenTUI 生命周期来源。

### Windows 独占句柄测试在等待 holder 就绪时偶发超时

#### 失败记录

- 工作流：`ci`
- 首次观测：运行 `30626426610`，尝试 `3`，作业 ID `91143472968`
- 再次观测：运行 `30677032216`，首次尝试，作业 ID `91306335828`
- 首次观测 Runner：`windows-2025-vs2026`，镜像版本 `20260728.188.1`
- 失败测试：`tests/core/session-index-store.test.ts` 中的“Windows独占句柄下验证读取、替换和旧索引完整性”

首次观测的关键时间线：

```text
0 ms     开始
11 ms    启动 PowerShell 独占句柄进程
4830 ms  独占句柄就绪
4830 ms  确认读取被拒绝
4883 ms  完成更新尝试
4884 ms  已发送释放信号
5015 ms  Bun 默认 5000 ms 测试超时
```

首次观测中，超时发生后 Bun 杀死悬挂子进程，`afterEach` 同时尝试删除仍被占用的临时目录，产生次生错误：

```text
EBUSY: resource busy or locked, rm
killed 1 dangling process
```

再次观测中，从“启动 PowerShell 独占句柄进程”到 5 秒超时之间没有出现“独占句柄就绪”。现有日志没有记录 holder 的退出状态、stdout、stderr 或脚本首条指令时间，因此无法判断 holder 是启动缓慢、在打开文件时阻塞、提前失败，还是发生了其他等待或死锁。

#### 已确认事实

- 该测试没有像紧邻的“锁等待失败返回警告且旧索引保持有效”测试一样显式设置超时，因此使用 Bun 默认的 5 秒。
- 首次观测在 4.83 秒时检测到 ready；随后的读取拒绝检查和业务更新约用 53 ms，并在总计约 4.884 秒时写入释放信号。
- 再次观测在 5 秒超时前没有检测到 ready，且缺少 holder 状态和输出，不能把这次失败归因为 PowerShell 冷启动。
- 成功对照的测试总耗时约为 2.503 秒和 3.997 秒，其中 ready 阶段分别约为 2.167 秒和 3.497 秒，证明该阶段耗时存在波动，但不足以证明所有失败都只是运行缓慢。
- 首次观测超时后出现 `EBUSY` 清理错误；`afterEach` 直接并发执行 `rm(..., { recursive: true, force: true })`，没有等待并确认 holder 已退出。

#### 尚未证实的可能原因

- PowerShell 或托管 Runner 的进程冷启动偶发超过 5 秒。
- holder 在 `[IO.File]::Open(...)` 处阻塞或失败。
- holder 已提前退出，但父测试只轮询 ready 文件，没有同时观察 `holder.exited`，因而一直等待到测试超时。
- 测试、文件系统、实时扫描程序或相关锁之间存在尚未定位的死锁或长时间阻塞。
- 5 秒默认超时可能不足，也可能只是暴露上述异常；在补齐诊断前不能把“提高超时”认定为修复。

#### 已补充的诊断能力

- holder 已记录脚本进入、打开句柄前后、写入 ready、等待和观察 release、释放句柄等阶段，并直接输出到现有 stdout。
- 所有测试已统一通过测试文件内的 `createDiagnosticTest` 声明业务超时；业务超时时输出 Bun 运行时、已注册进程和文件路径状态。
- 本测试已注册 Bun 测试进程、PowerShell holder、索引、ready、release 和脚本路径；超时时额外采集两个进程的轻量转储。
- CI 失败时上传诊断转储并保留七天；主 CI 五分钟后由 GitHub Actions 最终终止。

#### 待办

- [ ] 等待 ready 时同时观察 `holder.exited`；若子进程提前退出，应立即报告退出码，而不是继续轮询。
- [ ] 清理时先请求 holder 退出并有界等待；必要时终止进程，确认退出后再使用带退避重试的临时目录删除。
- [ ] 在 Windows CI 上连续运行该测试至少 100 次，统计各阶段耗时、提前退出次数和失败率，再判断应修复同步逻辑、子进程行为还是调整超时。
- [ ] 获得下一次超时转储后，结合线程栈判断是否存在 `File.Open`、文件系统或进程等待阻塞。

### 共同验收标准

- 两个测试分别在 Windows CI 连续运行至少 100 次无失败。
- 超时时能从日志直接判断失败阶段，并且清理不产生未处理错误或遗留进程。
- 修复不能通过删除真实 OpenTUI/Windows 文件句柄验证来换取稳定性。
- 完整 `bun run verify` 与分发验证继续通过。
