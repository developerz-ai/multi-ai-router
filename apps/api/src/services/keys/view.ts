import type { KeyScope } from "@multi-ai-router/core"
import type { ApiKeyRow } from "@multi-ai-router/db"

/**
 * What the console renders for a router key.
 *
 * `prefix` is the short leading slice that is already stored in clear and
 * indexed — `mar_live_8f3c…` — and is what a list shows. The **value is not
 * here**: it is returned only by the mint and the reveal, each of which is a
 * single, audited action. A list of keys is not one of them, so a screenshot of
 * the keys table leaks nothing.
 *
 * `revoked` is one-way and carries its timestamp, because "when did this stop
 * working" is the question a revoked key raises.
 */
export interface KeyRateLimitView {
  readonly requests: number
  readonly windowSeconds: number
}

export interface KeyScopeView {
  readonly kind: KeyScope
  readonly poolIds: readonly string[]
  readonly accountIds: readonly string[]
}

export interface ApiKeyView {
  readonly id: string
  readonly name: string
  /** The clear, indexed display prefix. Never the full value. */
  readonly prefix: string
  readonly scope: KeyScopeView
  readonly rateLimit: KeyRateLimitView | null
  readonly expiresAt: string | null
  readonly revoked: boolean
  readonly revokedAt: string | null
  readonly lastUsedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * The mint and the reveal, and nothing else, return this. Keys are retrievable
 * by design — no shown-once flow exists anywhere in this API
 * (docs/idea/04-api-keys-and-access.md#key-visibility--encrypted-not-hashed).
 */
export interface RevealedKey {
  readonly id: string
  readonly name: string
  /** The full `mar_live_…` value, decrypted for an authenticated admin session. */
  readonly value: string
}

export function toKeyView(row: ApiKeyRow, targets: KeyScopeTargets): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: {
      kind: row.scope,
      poolIds: targets.poolIds,
      accountIds: targets.accountIds,
    },
    rateLimit: toRateLimit(row),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revoked: row.revoked,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export interface KeyScopeTargets {
  readonly poolIds: readonly string[]
  readonly accountIds: readonly string[]
}

/** Half a rate limit is not one: both columns are set together or neither is. */
function toRateLimit(row: ApiKeyRow): KeyRateLimitView | null {
  if (row.rateLimitRequests === null || row.rateLimitWindowSeconds === null) return null
  return { requests: row.rateLimitRequests, windowSeconds: row.rateLimitWindowSeconds }
}
