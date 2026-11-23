/** `providers/free-tier.ts` — what a provider gives away, as its driver states it. */
export interface ProviderFreeTier {
  readonly access: "keyless" | "free-key"
  readonly url: string
  readonly note: string
  readonly verifiedAt: string
}

/** `providers/free-presets.ts` — a free service this provider reaches with a base URL and a key. */
export interface FreePreset {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly keyUrl: string
  readonly models: readonly string[]
  readonly note: string
  readonly kind: "standing" | "trial"
}
