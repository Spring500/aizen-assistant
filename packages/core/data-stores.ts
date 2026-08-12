import { join } from "node:path"
import { AppPreferencesStore } from "./app-preferences-store.ts"
import { ModelConfigStore } from "./model-config-store.ts"
import { projectDirectoryName } from "./paths.ts"
import { SessionStore } from "./session-store.ts"
import { SkillStore } from "./skill-store.ts"
import { ViewStore } from "./view-store.ts"

export type CoreDataStores = {
  sessions: SessionStore
  skills: SkillStore
  models: ModelConfigStore
  preferences: AppPreferencesStore
  views: ViewStore
}

/** 生产入口统一从这里取得 Core 持久化 Store，禁止在界面层分散实例化。 */
export function createCoreDataStores(dataDirectory: string, cwd: string): CoreDataStores {
  return {
    sessions: new SessionStore(join(dataDirectory, "sessions", projectDirectoryName(cwd)), {
      indexPath: join(dataDirectory, "cache", "session-index.json"),
    }),
    skills: new SkillStore({
      file: join(dataDirectory, "skills.json"),
      cacheDirectory: join(dataDirectory, "skill-sources"),
    }),
    models: new ModelConfigStore(join(dataDirectory, "custom-providers.json")),
    preferences: new AppPreferencesStore(join(dataDirectory, "preferences.json")),
    views: new ViewStore(join(dataDirectory, "views.json")),
  }
}
