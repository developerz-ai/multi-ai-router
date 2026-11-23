/**
 * What a provider gives away, stated by its driver so the console can tell an operator which
 * accounts cost nothing and where the key comes from (non-negotiable 12: the fact lives on the
 * driver, never in a list the console keeps).
 *
 * Operator-facing description only. Nothing here is read by routing or cost: a free tier's limit is
 * enforced by the upstream's own `429`, and whether an attempt cost anything is the price table's
 * question. Limits move often, so every entry is dated and re-checked weekly
 * (`.dz/briefs/free-providers.md`).
 */
export interface ProviderFreeTier {
  /** `keyless`: an Account needs no credential. `free-key`: a key that costs nothing to create. */
  readonly access: "keyless" | "free-key"
  /** Where an operator creates the key, or reads the terms when none is needed. */
  readonly url: string
  /** The published allowance and the catch, in one or two sentences. */
  readonly note: string
  /** The day this was read off the vendor's own page. */
  readonly verifiedAt: string
}
