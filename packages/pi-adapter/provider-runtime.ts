import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all"
import type { AuthEvent, AuthPrompt, Models, Provider } from "@earendil-works/pi-ai"
import type { PiProviderStore } from "../core/pi-provider-store.ts"
import type { PiProviderOption, PiPortEvent, ProviderAuthType } from "../core/pi-port.ts"

/** 只依赖 pi-ai，封装 pi 供应商的启用、认证、模型列表和手动刷新。 */
export class PiProviderRuntime {
  readonly #models: Models
  readonly #providerStore: PiProviderStore
  readonly #emit: (event: PiPortEvent) => void
  readonly #answers = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>()

  constructor(models: Models, providerStore: PiProviderStore, emit: (event: PiPortEvent) => void) {
    this.#models = models
    this.#providerStore = providerStore
    this.#emit = emit
  }

  async list(): Promise<PiProviderOption[]> {
    const builtin = new Set(getBuiltinProviders())
    const enabled = new Set((await this.#providerStore.read()).enabled)
    return Promise.all(
      this.#models
        .getProviders()
        .filter((provider) => builtin.has(provider.id as never))
        .map(async (provider) => this.#option(provider, enabled.has(provider.id))),
    )
  }

  async enabledProviderIds(): Promise<Set<string>> {
    return new Set((await this.#providerStore.read()).enabled)
  }

  async isBuiltin(providerId: string): Promise<boolean> {
    return getBuiltinProviders().includes(providerId as never)
  }

  async isEnabled(providerId: string): Promise<boolean> {
    return (await this.#providerStore.read()).enabled.includes(providerId)
  }

  async setEnabled(providerId: string, enabled: boolean): Promise<void> {
    if (!this.#models.getProvider(providerId)) throw new Error(`找不到 pi 供应商：${providerId}`)
    await this.#providerStore.setEnabled(providerId, enabled)
  }

  async login(providerId: string, authType: ProviderAuthType): Promise<void> {
    await this.#models.login(providerId, authType, {
      prompt: (prompt) => this.#prompt(prompt),
      notify: (event) => this.#notify(event),
    })
  }

  async refresh(providerId: string, signal?: AbortSignal): Promise<void> {
    const provider = this.#models.getProvider(providerId)
    if (!provider) throw new Error(`找不到 pi 供应商：${providerId}`)
    if (!provider.refreshModels) throw new Error(`pi 供应商 ${provider.name} 不支持刷新模型目录`)
    const result = await this.#models.refresh({ allowNetwork: true, force: true, ...(signal ? { signal } : {}) })
    const error = result.errors.get(providerId)
    if (error) throw error
    if (result.aborted) throw new Error("刷新供应商已取消")
  }

  answer(promptId: string, value: string): boolean {
    const pending = this.#answers.get(promptId)
    if (!pending) return false
    this.#answers.delete(promptId)
    pending.resolve(value)
    return true
  }

  cancel(): void {
    for (const pending of this.#answers.values()) pending.reject(new Error("认证已取消"))
    this.#answers.clear()
  }

  async #option(provider: Provider, enabled: boolean): Promise<PiProviderOption> {
    return {
      id: provider.id,
      name: provider.name,
      enabled,
      configured: (await this.#models.checkAuth(provider.id)) !== undefined,
      authTypes: [
        ...(provider.auth.apiKey?.login ? (["api_key"] as const) : []),
        ...(provider.auth.oauth?.login ? (["oauth"] as const) : []),
      ],
      modelCount: provider.getModels().length,
      canRefresh: provider.refreshModels !== undefined,
    }
  }

  async #prompt(prompt: AuthPrompt): Promise<string> {
    const promptId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      this.#answers.set(promptId, { resolve, reject })
      this.#emit({
        type: "auth_prompt",
        promptId,
        promptType: prompt.type === "secret" ? "secret" : prompt.type === "select" ? "select" : "text",
        message: prompt.message,
        ...(prompt.type !== "select" && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
        ...(prompt.type === "select"
          ? {
              options: prompt.options.map((option) => ({
                id: option.id,
                label: option.label,
                ...(option.description === undefined ? {} : { description: option.description }),
              })),
            }
          : {}),
      })
      prompt.signal?.addEventListener(
        "abort",
        () => {
          this.#answers.delete(promptId)
          reject(new Error("认证已取消"))
        },
        { once: true },
      )
    })
  }

  #notify(event: AuthEvent): void {
    if (event.type === "info" || event.type === "progress") {
      this.#emit({ type: "auth_notice", message: event.message })
    } else if (event.type === "auth_url") {
      this.#emit({ type: "auth_notice", message: event.instructions ?? "", links: [{ url: event.url }] })
    } else if (event.type === "device_code") {
      this.#emit({
        type: "auth_notice",
        message: `设备码：${event.userCode}`,
        deviceCode: {
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
        },
      })
    }
  }
}
