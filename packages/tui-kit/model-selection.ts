import type { ProviderConfigEntry } from "../core/model-config-store.ts"
import type { AuthProviderOption, ModelOption, PiProviderOption } from "../core/pi-port.ts"

export type ModelProviderChoice = {
  id: string
  name: string
  custom: boolean
  configured: boolean
  supportsApiKey: boolean
  models: ModelOption[]
}

export function modelProviderChoices(
  models: ModelOption[],
  authProviders: AuthProviderOption[],
  configuredProviders: ProviderConfigEntry[],
  piProviders: PiProviderOption[] = [],
): ModelProviderChoice[] {
  const auth = new Map(authProviders.map((provider) => [provider.id, provider]))
  const custom = new Map(configuredProviders.map((provider) => [provider.id, provider]))
  const pi = new Map(piProviders.filter((provider) => provider.enabled).map((provider) => [provider.id, provider]))
  const available = new Map<string, ModelOption[]>()
  for (const model of models) {
    if (!model.available) continue
    const current = available.get(model.providerId)
    if (current) current.push(model)
    else available.set(model.providerId, [model])
  }

  const ids = new Set([...custom.keys(), ...pi.keys(), ...available.keys()])

  return Array.from(ids, (id) => {
    const authProvider = auth.get(id)
    const customProvider = custom.get(id)
    const piProvider = pi.get(id)
    if (customProvider === undefined && piProvider === undefined && !available.has(id)) return undefined
    return {
      id,
      name: customProvider?.name ?? piProvider?.name ?? authProvider?.name ?? id,
      custom: customProvider !== undefined,
      configured: piProvider?.configured ?? authProvider?.configured ?? false,
      supportsApiKey: piProvider?.authTypes.includes("api_key") ?? authProvider?.supportsApiKey ?? false,
      models: (available.get(id) ?? []).sort((left, right) => left.name.localeCompare(right.name)),
    }
  })
    .filter((provider): provider is ModelProviderChoice => provider !== undefined)
    .sort((left, right) => {
      if (left.custom !== right.custom) return left.custom ? -1 : 1
      return left.name.localeCompare(right.name)
    })
}

/**
 * 构建 providerId → 供应商显示名的映射，优先级与 modelProviderChoices 一致：
 * 自定义配置名 > 已启用的 pi 供应商名 > 认证供应商名；无匹配时调用方回退 providerId。
 * 与 modelProviderChoices 不同，这里不要求供应商当前有可用模型，
 * 便于已保存的模型引用在供应商暂时无模型时仍能显示名称。
 */
export function providerDisplayNames(
  authProviders: AuthProviderOption[],
  configuredProviders: ProviderConfigEntry[],
  piProviders: PiProviderOption[] = [],
): Map<string, string> {
  const names = new Map<string, string>()
  for (const provider of configuredProviders) names.set(provider.id, provider.name)
  for (const provider of piProviders)
    if (provider.enabled && !names.has(provider.id)) names.set(provider.id, provider.name)
  for (const provider of authProviders) if (!names.has(provider.id)) names.set(provider.id, provider.name)
  return names
}

export function unconfiguredAuthProviders(authProviders: AuthProviderOption[]): AuthProviderOption[] {
  return authProviders
    .filter((provider) => provider.supportsApiKey && !provider.configured)
    .sort((left, right) => left.name.localeCompare(right.name))
}
