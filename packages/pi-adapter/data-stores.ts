import { ModelConfigStore } from "../core/model-config-store.ts"
import { PiProviderStore } from "../core/pi-provider-store.ts"
import { PiCredentialStore, PiModelsCacheStore } from "./pi-stores.ts"

export type PiDataStores = {
  credentials: PiCredentialStore
  modelsCache?: PiModelsCacheStore
  providers?: PiProviderStore
  modelConfig?: ModelConfigStore
}

export function createPiDataStores(options: {
  authPath: string
  piModelsCachePath?: string
  piProvidersPath?: string
  customProvidersPath?: string | null
}): PiDataStores {
  return {
    credentials: new PiCredentialStore(options.authPath),
    ...(options.piModelsCachePath ? { modelsCache: new PiModelsCacheStore(options.piModelsCachePath) } : {}),
    ...(options.piProvidersPath ? { providers: new PiProviderStore(options.piProvidersPath) } : {}),
    ...(options.customProvidersPath ? { modelConfig: new ModelConfigStore(options.customProvidersPath) } : {}),
  }
}
