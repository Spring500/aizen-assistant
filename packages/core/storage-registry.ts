export type PersistentResourceRegistration = {
  id: string
  shape: "catalog" | "document" | "append-log" | "cache"
  implementations: Array<{ file: string; symbol: string }>
  constructionFiles: string[]
}

/**
 * 所有持久化资源都必须在这里登记。静态检查会阻止新增 Store、落盘器或文件系统入口绕过清单。
 * permission-gaps 仅登记现状；是否删除由后续专项处理。
 */
export const persistentResourceRegistry: PersistentResourceRegistration[] = [
  {
    id: "sessions",
    shape: "catalog",
    implementations: [
      { file: "packages/core/session-store.ts", symbol: "SessionStore" },
      { file: "packages/core/session-index-store.ts", symbol: "SessionIndexStore" },
    ],
    constructionFiles: ["packages/core/data-stores.ts", "packages/core/session-store.ts"],
  },
  {
    id: "views",
    shape: "catalog",
    implementations: [{ file: "packages/core/view-store.ts", symbol: "ViewStore" }],
    constructionFiles: ["packages/core/data-stores.ts"],
  },
  {
    id: "skills",
    shape: "catalog",
    implementations: [{ file: "packages/core/skill-store.ts", symbol: "SkillStore" }],
    constructionFiles: ["packages/core/data-stores.ts"],
  },
  {
    id: "model-config",
    shape: "document",
    implementations: [{ file: "packages/core/model-config-store.ts", symbol: "ModelConfigStore" }],
    constructionFiles: ["packages/core/data-stores.ts", "packages/pi-adapter/data-stores.ts"],
  },
  {
    id: "preferences",
    shape: "document",
    implementations: [{ file: "packages/core/app-preferences-store.ts", symbol: "AppPreferencesStore" }],
    constructionFiles: ["packages/core/data-stores.ts"],
  },
  {
    id: "pi-providers",
    shape: "document",
    implementations: [{ file: "packages/core/pi-provider-store.ts", symbol: "PiProviderStore" }],
    constructionFiles: ["packages/pi-adapter/data-stores.ts"],
  },
  {
    id: "credentials",
    shape: "document",
    implementations: [{ file: "packages/pi-adapter/pi-stores.ts", symbol: "PiCredentialStore" }],
    constructionFiles: ["packages/pi-adapter/data-stores.ts"],
  },
  {
    id: "pi-model-cache",
    shape: "cache",
    implementations: [{ file: "packages/pi-adapter/pi-stores.ts", symbol: "PiModelsCacheStore" }],
    constructionFiles: ["packages/pi-adapter/data-stores.ts"],
  },
  {
    id: "permission-audit",
    shape: "append-log",
    implementations: [
      { file: "packages/core/tool-permissions/permission-audit.ts", symbol: "JsonlPermissionAuditRecorder" },
    ],
    constructionFiles: ["apps/tui/interactive-app.ts"],
  },
  {
    id: "permission-gaps",
    shape: "append-log",
    implementations: [{ file: "packages/core/tool-permissions/gap-recorder.ts", symbol: "JsonlPermissionGapRecorder" }],
    constructionFiles: ["apps/tui/interactive-app.ts"],
  },
]

/** 这些文件允许直接访问文件系统；新增入口必须先说明归属并更新本表。 */
export const filesystemAccessPolicy: Record<string, string> = {
  "packages/core/aizen-core.ts": "读取用户显式提交的附件",
  "packages/core/app-preferences-store.ts": "应用偏好文档",
  "packages/core/file-transaction.ts": "持久化事务基础设施",
  "packages/core/git-fetch.ts": "Skill 来源缓存",
  "packages/core/model-config-store.ts": "模型配置文档",
  "packages/core/pi-provider-store.ts": "pi 供应商配置文档",
  "packages/core/project-context.ts": "读取项目上下文",
  "packages/core/session-index-store.ts": "会话可重建索引",
  "packages/core/session-store.ts": "会话目录",
  "packages/core/skill-store.ts": "Skill 登记与来源缓存",
  "packages/core/tool-permissions/classifiers/file.ts": "权限分类时读取目标文件元数据",
  "packages/core/tool-permissions/gap-recorder.ts": "权限 gap 日志（待专项清理）",
  "packages/core/tool-permissions/permission-audit.ts": "权限审计日志",
  "packages/core/view-config.ts": "视图目录配置",
  "packages/core/view-store.ts": "视图登记与目录",
  "packages/pi-adapter/pi-stores.ts": "pi 凭据与模型缓存",
}
