import type { AuthProviderOption, ModelOption } from "../core/pi-port.ts"

export type SelectableModelProvider = {
  id: string
  name: string
  models: ModelOption[]
}

export function selectableModelProviders(
  models: ModelOption[],
  authProviders: AuthProviderOption[],
): SelectableModelProvider[] {
  const names = new Map(authProviders.map((provider) => [provider.id, provider.name]))
  const grouped = new Map<string, ModelOption[]>()
  for (const model of models) {
    if (!model.available) continue
    const current = grouped.get(model.providerId)
    if (current) current.push(model)
    else grouped.set(model.providerId, [model])
  }
  return Array.from(grouped, ([id, providerModels]) => ({
    id,
    name: names.get(id) ?? id,
    models: providerModels.sort((left, right) => left.name.localeCompare(right.name)),
  })).sort((left, right) => left.name.localeCompare(right.name))
}
