---
title: 启动参数
type: reference
module: reference
sort: 1
---

# 启动参数

| 参数 | 行为 |
|---|---|
| `--data-dir <目录>` | 指定本地数据目录；相对路径以启动时的工作目录为基准，且不能指定为当前工作目录。 |
| `--collect-permission-gaps` | 将权限规则缺口记录到 `<数据目录>/local-observations/permission-gaps.jsonl`。完全开放模式会额外运行验证器但始终放行且不触发 AI 或人工审核，其他模式复用正常验证结果。 |
