// 本文件由 scripts/gen-sidebar.ts 自动生成，请勿手工编辑。
import type { DefaultTheme } from "vitepress"

export const sidebar: DefaultTheme.Sidebar = {
  "/zh/": [
    {
      text: "用户指南",
      items: [
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
      text: "开发者文档",
      items: [
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
