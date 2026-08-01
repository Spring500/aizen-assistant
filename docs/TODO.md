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

#### 待办与需要补充的诊断

- [ ] 将初始页面的固定 `Bun.sleep(20)` 改为有明确超时和最终帧输出的 `waitForText()`，区分“初始化较慢”和“页面状态错误”。
- [ ] 为 `ChatView` 增加仅测试启用的生命周期事件记录：resize 收到时间、计时器编号、调度/取消/进入/退出、`destroy()` 开始与结束、最后一次 `update()`。
- [ ] 在 resize 回调和公开更新方法中加入销毁状态保护，并用测试证明销毁后不会访问 OpenTUI renderable；实现前先确认这不会掩盖真实的应用生命周期错误。
- [ ] 在子场景失败时输出当前交互阶段、应用是否已退出、renderer 尺寸和最后一帧，不只输出最终断言。
- [ ] 在 Windows CI 上对 `invalid-model` 子场景至少连续运行 100 次，并单独记录失败率；随后再运行完整五场景压力测试。
- [ ] 确认 OpenTUI `0.4.5` 对测试 renderer 的 resize 和 renderable 销毁契约；如需改变适配层行为，依据锁定版本源码和类型声明处理。

### Windows 独占句柄测试受 PowerShell 启动延迟影响并触发清理错误

#### 失败记录

- 工作流：`ci`
- 运行：`30626426610`
- 尝试：`3`
- 作业：`verify`，ID `91143472968`
- Runner：`windows-2025-vs2026`，镜像版本 `20260728.188.1`
- 失败测试：`tests/core/session-index-store.test.ts` 中的“Windows独占句柄下验证读取、替换和旧索引完整性”

关键时间线：

```text
0 ms     开始
11 ms    启动 PowerShell 独占句柄进程
4830 ms  独占句柄就绪
4830 ms  确认读取被拒绝
4883 ms  完成更新尝试
4884 ms  已发送释放信号
5015 ms  Bun 默认 5000 ms 测试超时
```

超时发生后 Bun 杀死悬挂子进程，`afterEach` 同时尝试删除仍被占用的临时目录，产生次生错误：

```text
EBUSY: resource busy or locked, rm
killed 1 dangling process
```

#### 已查结论

- 该测试没有像紧邻的“锁等待失败返回警告且旧索引保持有效”测试一样显式设置超时，因此使用 Bun 默认的 5 秒。
- 4.83 秒主要消耗在等待 PowerShell 创建独占句柄并写入 ready 文件；业务更新只用了约 53 ms。
- 成功对照同样存在明显环境波动：第二次尝试约 2.503 秒，最终 CI 约 3.997 秒；其中 PowerShell/ready 阶段分别约 2.167 秒和 3.497 秒。
- 失败时已经完成了被占用索引的更新尝试和释放信号写入，只差等待 holder 正常退出及断言，说明 5 秒阈值过紧，不能代表业务语义失败。
- `afterEach` 直接并发 `rm(..., { recursive: true, force: true })`，没有采用项目已有临时目录工具的 Windows 重试策略，故超时后容易把句柄释放延迟放大成 `EBUSY` 未处理错误。

#### 待办与需要补充的诊断

- [ ] 为该测试设置与真实外部进程成本匹配的显式超时，初步建议 15 秒；不要只扩大 ready 轮询次数而保留 5 秒总超时。
- [ ] 把“等待 ready”“业务更新”“等待 holder 退出”分别设置有界超时并给出阶段化错误，避免只得到整个测试超时。
- [ ] 清理时先确保 holder 已退出，再使用带退避重试的临时目录删除；超时路径也必须收集 holder 的退出码、stdout 和 stderr。
- [ ] 记录 `powershell.exe` 路径与版本、Runner 镜像版本、子进程启动至首条脚本指令的耗时，以判断延迟来自进程冷启动还是脚本内部。
- [ ] 在 Windows CI 上连续运行该测试至少 100 次，统计 ready、业务更新和退出三个阶段的 P50、P95、最大值及失败率。
- [ ] 评估改用当前进程可直接控制的 Windows 句柄辅助程序，减少 PowerShell 冷启动噪声；若增加测试辅助二进制，需要保证测试仍验证真实 Windows 独占句柄语义。

### 共同验收标准

- 两个测试分别在 Windows CI 连续运行至少 100 次无失败。
- 超时时能从日志直接判断失败阶段，并且清理不产生未处理错误或遗留进程。
- 修复不能通过删除真实 OpenTUI/Windows 文件句柄验证来换取稳定性。
- 完整 `bun run verify` 与分发验证继续通过。
