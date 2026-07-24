import { createHash } from "node:crypto"
import { KeyRevokedError, routerKeyDisplayPrefix } from "@multi-ai-router/core"
import type { ApiKeyRepository, ApiKeyRow } from "@multi-ai-router/db"
import { timingSafeEqualStrings } from "../../admin-auth"
import type { CredentialCipher } from "../../crypto/cipher"
import type { KeyScopeSnapshot } from "../../routing"
import { createTtlCache, type TtlCache } from "./cache"
import type { KeyScopeLoader } from "./scope"

/**
 * Router key verification.
 *
 * The path, exactly as `04-api-keys-and-access.md#verification-path` states it:
 *
 *     presented key -> indexed lookup by display prefix -> decrypt -> constant-time compare
 *                   -> revoked / expired check -> resolved scope
 *
 * Keys are **encrypted, not hashed**, because the operator must be able to look one up again
 * without rotating it — which is why verification decrypts and compares rather than hashing the
 * presentation. The compare is constant-time; the prefix index narrows the candidate rows, it
 * never decides.
 *
 * **Verified keys are cached in memory.** The performance budget forbids a database round trip per
 * request, so a hit costs a digest and a map lookup and a miss costs one indexed query. Failures
 * are cached too, on a shorter TTL, so a client looping on a bad key cannot turn itself into a
 * query generator.
 *
 * Revocation is immediate for new requests, which a TTL alone cannot deliver — the admin plane
 * calls {@link RouterKeyVerifier.invalidate} when it revokes or edits a key. In-flight requests
 * finish either way: the router never tears down a stream mid-response.
 */

export interface VerifiedKey {
  readonly id: string
  readonly name: string
  /** The clear, indexed display prefix. Safe to log; it is what admin lists show. */
  readonly prefix: string
  readonly scope: KeyScopeSnapshot
  /** Per-key ceiling. Null means no per-key limit. */
  readonly rateLimitRequests: number | null
  readonly rateLimitWindowSeconds: number | null
  readonly expiresAt: Date | null
}

export interface RouterKeyVerifierDeps {
  readonly repository: Pick<ApiKeyRepository, "findUsableByPrefix">
  readonly cipher: Pick<CredentialCipher, "decrypt">
  readonly loadScope: KeyScopeLoader
  readonly now?: () => Date
  readonly cache?: RouterKeyCacheOptions
  /**
   * Fired once per cache miss that verified. `touchLastUsed` belongs here — it is a write, so it
   * must not be awaited on the request path.
   */
  readonly onVerified?: (key: VerifiedKey) => void
}

export interface RouterKeyCacheOptions {
  readonly maxEntries?: number
  readonly ttlMs?: number
  /** How long an unknown key stays refused from memory. Short: a key may be minted at any time. */
  readonly negativeTtlMs?: number
}

export const DEFAULT_KEY_CACHE_MAX_ENTRIES = 4_096
export const DEFAULT_KEY_CACHE_TTL_MS = 60_000
export const DEFAULT_KEY_CACHE_NEGATIVE_TTL_MS = 5_000

export interface RouterKeyVerifier {
  /** @throws KeyRevokedError when the key is unknown, revoked, expired, or malformed. */
  verify(presented: string): Promise<VerifiedKey>
  /** Drops every cached entry for one key. Called by the admin plane on revoke or edit. */
  invalidate(keyId: string): void
  invalidateAll(): void
}

const UNKNOWN_KEY = "The presented router API key is unknown, revoked, or expired"

type CacheEntry = { readonly ok: true; readonly key: VerifiedKey } | { readonly ok: false }

export function createRouterKeyVerifier(deps: RouterKeyVerifierDeps): RouterKeyVerifier {
  const now = deps.now ?? (() => new Date())
  const ttlMs = deps.cache?.ttlMs ?? DEFAULT_KEY_CACHE_TTL_MS
  const negativeTtlMs = deps.cache?.negativeTtlMs ?? DEFAULT_KEY_CACHE_NEGATIVE_TTL_MS
  const cache: TtlCache<CacheEntry> = createTtlCache({
    maxEntries: deps.cache?.maxEntries ?? DEFAULT_KEY_CACHE_MAX_ENTRIES,
    ttlMs,
    now: () => now().getTime(),
  })
  // keyId -> the digests caching it, so a revocation can find them without scanning.
  const byKeyId = new Map<string, Set<string>>()

  const remember = (digest: string, entry: CacheEntry): void => {
    cache.set(digest, entry, entry.ok ? ttlMs : negativeTtlMs)
    if (!entry.ok) return
    const digests = byKeyId.get(entry.key.id) ?? new Set<string>()
    digests.add(digest)
    byKeyId.set(entry.key.id, digests)
  }

  const match = (rows: readonly ApiKeyRow[], presented: string): ApiKeyRow | null => {
    for (const row of rows) {
      let stored: string
      try {
        stored = deps.cipher.decrypt(row.value)
      } catch {
        // A row this router cannot decrypt (rotated or corrupt envelope) is not a match and is
        // not a reason to fail every other candidate sharing the prefix.
        continue
      }
      if (timingSafeEqualStrings(stored, presented)) return row
    }
    return null
  }

  return {
    async verify(presented) {
      // A malformed value never reaches the database as a query parameter.
      const prefix = routerKeyDisplayPrefix(presented)
      if (prefix === null) throw new KeyRevokedError(UNKNOWN_KEY)

      const digest = createHash("sha256").update(presented, "utf8").digest("base64url")
      const cached = cache.get(digest)
      if (cached !== undefined) {
        if (!cached.ok) throw new KeyRevokedError(UNKNOWN_KEY)
        if (isExpired(cached.key, now())) {
          cache.delete(digest)
          throw new KeyRevokedError(UNKNOWN_KEY)
        }
        return cached.key
      }

      // The query already excludes revoked and expired rows, so a prefix that returns nothing and
      // a prefix whose rows do not match are the same answer to the caller — deliberately.
      const rows = await deps.repository.findUsableByPrefix(prefix, now())
      const row = match(rows, presented)
      if (row === null) {
        remember(digest, { ok: false })
        throw new KeyRevokedError(UNKNOWN_KEY)
      }

      const key: VerifiedKey = {
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        scope: await deps.loadScope(row),
        rateLimitRequests: row.rateLimitRequests,
        rateLimitWindowSeconds: row.rateLimitWindowSeconds,
        expiresAt: row.expiresAt,
      }
      remember(digest, { ok: true, key })
      deps.onVerified?.(key)
      return key
    },

    invalidate(keyId) {
      for (const digest of byKeyId.get(keyId) ?? []) cache.delete(digest)
      byKeyId.delete(keyId)
    },

    invalidateAll() {
      cache.clear()
      byKeyId.clear()
    },
  }
}

/** A key past its expiry is refused exactly like a revoked one. */
function isExpired(key: VerifiedKey, at: Date): boolean {
  return key.expiresAt !== null && key.expiresAt.getTime() <= at.getTime()
}
