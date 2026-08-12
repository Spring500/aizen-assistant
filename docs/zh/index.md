---
title: AizenAssistant 文档
---

# AizenAssistant

面向重度 Coding Agent 用户的本地 Coding Agent 应用：适合长期维护项目、频繁切换任务方式，并希望对 Agent 上下文做定制化管理的开发者。

## 文档入口

**用户指南**——面向使用者，无需技术背景：

- [快速开始](./core/quickstart.md)：环境准备与启动
- [安装与运行](./core/installation.md)：开发命令与可执行程序构建
- [数据存储](./core/data-storage.md)：数据目录内容与备份
- [会话管理](./core/session.md)：会话的创建、回退、分支与恢复
- [后续计划](./core/roadmap.md)：已确认但未实现的功能规划
- [视图式上下文](./core/views.md)：视图的组成与加载规则
- [全局技能管理](./core/skills.md)：引入与安装技能
- [权限系统使用说明](./permission/usage.md)：权限系统的介入时机与配置
- [自举套件使用说明](./bootstrap-suite/usage.md)：用一句话指挥模型

**参考**——结构化信息：

- [启动参数](./reference/cli-flags.md)

**开发者文档**——面向实现与维护者：

- [权限系统实现规格](./permission/spec.md)：内部机制、接口契约与边界条件
- [权限系统内置分类器说明](./permission/classifier.md)：当前内置规则覆盖范围
- [自举套件实现规格](./bootstrap-suite/spec.md)：总体结构与扩展方式

## 项目信息

- 源码仓库与项目门面：[GitHub 仓库](https://github.com/Spring500/aizen-assistant)
- 参与开发：见 [CONTRIBUTING.md](https://github.com/Spring500/aizen-assistant/blob/main/CONTRIBUTING.md)
