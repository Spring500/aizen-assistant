---
title: 启动参数
type: reference
module: reference
sort: 1
---

# 启动参数

## 交互模式

| 参数 | 行为 |
|---|---|
| `--data-dir <目录>` | 指定本地数据目录；相对路径以启动时的工作目录为基准，且不能指定为当前工作目录。 |
| `--collect-permission-gaps` | 将权限规则缺口记录到 `<数据目录>/local-observations/permission-gaps.jsonl`。完全开放模式会额外运行验证器但始终放行且不触发 AI 或人工审核，其他模式复用正常验证结果。 |

## 分发子命令

| 命令 | 行为 |
|---|---|
| `aizen-assistant update` | 检查并安装最新版本：查询 GitHub Releases → 下载 → SHA256 校验 → 原子替换自身。便携模式（未通过安装脚本安装）无法自动更新。 |
| `aizen-assistant uninstall [--yes]` | 卸载：确认后删除 `~/.aizen` 并回滚 PATH；`--yes` 跳过确认（非交互终端必须显式指定）。 |
