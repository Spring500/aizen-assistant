/**
 * VitePress 站点配置。
 *
 * 中文内容位于 docs/zh/（当前唯一语言，将来新增 docs/en/ 时在此声明对应 locale）。
 * 侧边栏由 scripts/gen-sidebar.ts 自动生成，勿在此手工维护。
 */
import { defineConfig } from "vitepress"
import { sidebar } from "./sidebar.generated"

export default defineConfig({
  lang: "zh-CN",
  title: "AizenAssistant",
  description: "面向重度 Coding Agent 用户的本地 Coding Agent 应用",
  cleanUrls: true,
  locales: {
    "/zh/": { label: "中文", lang: "zh-CN" },
  },
  themeConfig: {
    nav: [{ text: "首页", link: "/zh/" }],
    sidebar,
  },
})
