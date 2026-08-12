// 本文件由 scripts/gen-sidebar.ts 自动生成，请勿手工编辑。
import type { DefaultTheme } from "vitepress"

export const sidebar: DefaultTheme.Sidebar = {
  "/zh/": [
    {
      text: "用户指南",
      items: [
        {
          text: "快速开始",
          link: "/zh/core/quickstart"
        },
        {
          text: "安装与运行",
          link: "/zh/core/installation"
        },
        {
          text: "数据存储",
          link: "/zh/core/data-storage"
        },
        {
          text: "视图式上下文",
          link: "/zh/core/views"
        },
        {
          text: "全局技能管理",
          link: "/zh/core/skills"
        },
        {
          text: "会话管理",
          link: "/zh/core/session"
        },
        {
          text: "后续计划",
          link: "/zh/core/roadmap"
        },
        {
          text: "权限系统使用说明",
          link: "/zh/permission/usage"
        },
        {
          text: "自举套件使用说明",
          link: "/zh/bootstrap-suite/usage"
        },
      ],
    },
    {
      text: "参考",
      items: [
        {
          text: "启动参数",
          link: "/zh/reference/cli-flags"
        },
      ],
    },
    {
      text: "开发者文档",
      items: [
        {
          text: "会话文件错误隔离",
          link: "/zh/core/storage-isolation"
        },
        {
          text: "权限系统实现规格",
          link: "/zh/permission/spec"
        },
        {
          text: "权限系统内置分类器说明",
          link: "/zh/permission/classifier"
        },
        {
          text: "自举套件实现规格",
          link: "/zh/bootstrap-suite/spec"
        },
      ],
    },
  ],
}
