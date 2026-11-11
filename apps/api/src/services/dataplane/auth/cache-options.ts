/** The router-key caches' bounds — every one an env setting (`config/runtime-limits.ts`). */
export interface RouterKeyCacheOptions {
  readonly maxEntries?: number
  readonly ttlMs?: number
  /** How long an unknown key stays refused from memory. Short: a key may be minted at any time. */
  readonly negativeTtlMs?: number
  /** Refusals remembered, separately from verified keys so they can never evict one. */
  readonly negativeMaxEntries?: number
  /** Concurrent cache-miss lookups; past it a miss is refused `503` + `Retry-After`. */
  readonly maxPendingLoads?: number
  /** How long past its TTL a verified key is still served when its reload hits a store error. */
  readonly staleOnErrorMs?: number
  /** Share of the TTL after which a hit also starts a background reload. */
  readonly refreshAheadFraction?: number
  /** Reloads a continuously-edited key gets before it is refused as busy. */
  readonly maxLoadAttempts?: number
  /** `Retry-After` on a busy or unreachable store. */
  readonly unavailableRetryAfterSeconds?: number
}
