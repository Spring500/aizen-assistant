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

## 分发子命令

以下命令仅适用于通过安装脚本（install.sh / install.ps1）装出的分发版本；源码运行（bun 启动）与便携拷贝不支持。

| 命令 | 行为 |
|---|---|
| `aizen-assistant update [--release-api <url>]` | 检查并安装最新版本：查询 GitHub Releases → 下载 → SHA256 校验 → 原子替换自身。便携模式（未通过安装脚本安装）无法自动更新。`--release-api` 指定发布 API 地址（测试或自建镜像场景）。 |
| `aizen-assistant uninstall [--yes] [--skip-path]` | 卸载：确认后删除 `~/.aizen` 并回滚 PATH；`--yes` 跳过确认（非交互终端必须显式指定）；`--skip-path` 跳过 PATH 回滚（测试/无副作用场景）。 |
