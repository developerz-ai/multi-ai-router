import { createHash } from "node:crypto"
import {
  KeyRevokedError,
  KeyVerificationUnavailableError,
  routerKeyDisplayPrefix,
} from "@multi-ai-router/core"
import type { ApiKeyRepository, ApiKeyRow } from "@multi-ai-router/db"
import { timingSafeEqualStrings } from "../../admin-auth"
import type { CredentialCipher } from "../../crypto/cipher"
import type { KeyScopeSnapshot } from "../../routing"
import { createTtlCache } from "./cache"
import type { RouterKeyCacheOptions } from "./cache-options"
import type { KeyCandidateLoader, KeyScopeLoader } from "./scope"

export type { RouterKeyCacheOptions } from "./cache-options"

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
 * request, so a hit costs a digest and a map lookup and a miss costs one indexed query (prefix
 * row and scope targets together, `repositoryCandidateLoader`). Failures are cached too, on a
 * shorter TTL and in a cache of their own: a spray of unknown keys can neither evict a verified key
 * nor queue more than `maxPendingLoads` lookups on the pool the rest of the router shares.
 *
 * **A warm key never waits on the database.** Past `refreshAheadFraction` of its TTL a hit is
 * answered from memory and one background reload starts; only a key whose TTL ran out with no
 * reload landed waits. If that reload fails on a store error (Postgres restarting), the last
 * verified copy is served for up to `staleOnErrorMs` past its TTL; with nothing to serve the
 * request gets a typed `503` + `Retry-After`, never a generic `500` (prod 2026-10-31: 52 of them).
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

/**
 * Where candidate rows come from: one combined statement (`loadCandidates`, production), or the
 * prefix query plus a scope loader for the matched row.
 */
export type RouterKeyVerifierDeps = RouterKeyVerifierBase &
  (
    | { readonly loadCandidates: KeyCandidateLoader }
    | {
        readonly repository: Pick<ApiKeyRepository, "findUsableByPrefix">
        readonly loadScope: KeyScopeLoader
      }
  )

interface RouterKeyVerifierBase {
  readonly cipher: Pick<CredentialCipher, "decrypt">
  readonly now?: () => Date
  readonly cache?: RouterKeyCacheOptions
  /**
   * Fired once per cache miss that verified. `touchLastUsed` belongs here — it is a write, so it
   * must not be awaited on the request path.
   */
  readonly onVerified?: (key: VerifiedKey) => void
}

export const DEFAULT_KEY_CACHE_MAX_ENTRIES = 4_096
export const DEFAULT_KEY_CACHE_TTL_MS = 60_000
export const DEFAULT_KEY_CACHE_NEGATIVE_TTL_MS = 5_000

export interface RouterKeyVerifier {
  /**
   * @throws KeyRevokedError when the key is unknown, revoked, expired, or malformed.
   * @throws KeyVerificationUnavailableError on bounded-load saturation, repeated invalidation, or a
   *   store failure with no verified copy to serve.
   */
  verify(presented: string): Promise<VerifiedKey>
  /** Drops every cached entry for one key. Called by the admin plane on revoke or edit. */
  invalidate(keyId: string): void
  invalidateAll(): void
}

const UNKNOWN_KEY = "The presented router API key is unknown, revoked, or expired"
const VERIFICATION_BUSY = "Router API key verification is temporarily unavailable; retry shortly"

interface Verified {
  readonly key: VerifiedKey
  readonly loadedAtMs: number
}

export function createRouterKeyVerifier(deps: RouterKeyVerifierDeps): RouterKeyVerifier {
  const now = deps.now ?? (() => new Date())
  const nowMs = () => now().getTime()
  const options = deps.cache ?? {}
  const ttlMs = options.ttlMs ?? DEFAULT_KEY_CACHE_TTL_MS
  const negativeTtlMs = options.negativeTtlMs ?? DEFAULT_KEY_CACHE_NEGATIVE_TTL_MS
  const staleOnErrorMs = options.staleOnErrorMs ?? 0
  const refreshAheadMs = ttlMs * (options.refreshAheadFraction ?? 0.8)
  const maxPending = options.maxPendingLoads ?? 32
  const maxLoadAttempts = options.maxLoadAttempts ?? 3
  const retryAfterSeconds = options.unavailableRetryAfterSeconds ?? 1
  const maxEntries = options.maxEntries ?? DEFAULT_KEY_CACHE_MAX_ENTRIES
  // Kept until the stale-on-error window closes; freshness is judged from `loadedAtMs`.
  const verified = createTtlCache<Verified>({
    maxEntries,
    ttlMs: ttlMs + staleOnErrorMs,
    now: nowMs,
  })
  const refused = createTtlCache<true>({
    maxEntries: options.negativeMaxEntries ?? 1_024,
    ttlMs: negativeTtlMs,
    now: nowMs,
  })
  // keyId -> the digests caching it, so a revocation can find them without scanning.
  const byKeyId = new Map<string, Set<string>>()
  const inFlight = new Map<string, Promise<VerifiedKey>>()
  let generation = 0

  const busy = (cause?: unknown) =>
    new KeyVerificationUnavailableError(VERIFICATION_BUSY, {
      retryAfterSeconds,
      ...(cause === undefined ? {} : { cause }),
    })

  const remember = (digest: string, key: VerifiedKey): void => {
    if (byKeyId.size >= maxEntries) {
      for (const [id, digests] of byKeyId) {
        for (const cachedDigest of digests) {
          if (verified.get(cachedDigest) === undefined) digests.delete(cachedDigest)
        }
        if (digests.size === 0) byKeyId.delete(id)
      }
    }
    verified.set(digest, { key, loadedAtMs: nowMs() })
    const digests = byKeyId.get(key.id) ?? new Set<string>()
    digests.add(digest)
    byKeyId.set(key.id, digests)
  }

  const forget = (digest: string): void => {
    verified.delete(digest)
    // Zero means "do not cache a miss at all" — not "cache it already expired", which still evicts.
    if (negativeTtlMs > 0) refused.set(digest, true)
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

  const lookup = async (
    prefix: string,
    presented: string,
  ): Promise<{ row: ApiKeyRow; scope: KeyScopeSnapshot } | null> => {
    if ("loadCandidates" in deps) {
      const candidates = await deps.loadCandidates(prefix, now())
      const row = match(
        candidates.map((candidate) => candidate.row),
        presented,
      )
      const found = candidates.find((candidate) => candidate.row === row)
      return found === undefined ? null : found
    }
    // The query excludes revoked and expired rows; a miss and a mismatching prefix are
    // deliberately indistinguishable to the caller.
    const row = match(await deps.repository.findUsableByPrefix(prefix, now()), presented)
    return row === null ? null : { row, scope: await deps.loadScope(row) }
  }

  const load = async (digest: string, prefix: string, presented: string) => {
    // An unrelated key edit also advances the fence. Reload within this same coalesced slot
    // instead of calling a valid credential revoked, but bound work under continuous edits.
    for (let attempt = 0; attempt < maxLoadAttempts; attempt++) {
      const startedGeneration = generation
      const found = await lookup(prefix, presented)
      if (startedGeneration !== generation) continue
      if (found === null) {
        forget(digest)
        throw new KeyRevokedError(UNKNOWN_KEY)
      }
      const { row, scope } = found
      const key: VerifiedKey = {
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        scope,
        rateLimitRequests: row.rateLimitRequests,
        rateLimitWindowSeconds: row.rateLimitWindowSeconds,
        expiresAt: row.expiresAt,
      }
      if (isExpired(key, now())) {
        verified.delete(digest)
        throw new KeyRevokedError(UNKNOWN_KEY)
      }
      remember(digest, key)
      deps.onVerified?.(key)
      return key
    }
    throw busy()
  }

  /** One coalesced load per digest; `null` when the pending ceiling refuses a new one. */
  const startLoad = (digest: string, prefix: string, presented: string) => {
    const pending = inFlight.get(digest)
    if (pending !== undefined) return pending
    if (inFlight.size >= maxPending) return null
    const loading = load(digest, prefix, presented).finally(() => {
      if (inFlight.get(digest) === loading) inFlight.delete(digest)
    })
    inFlight.set(digest, loading)
    return loading
  }

  return {
    async verify(presented) {
      // A malformed value never reaches the database as a query parameter.
      const prefix = routerKeyDisplayPrefix(presented)
      if (prefix === null) throw new KeyRevokedError(UNKNOWN_KEY)

      const digest = createHash("sha256").update(presented, "utf8").digest("base64url")
      if (refused.get(digest) !== undefined) throw new KeyRevokedError(UNKNOWN_KEY)

      const cached = verified.get(digest)
      if (cached !== undefined && isExpired(cached.key, now())) {
        verified.delete(digest)
        throw new KeyRevokedError(UNKNOWN_KEY)
      }
      const ageMs = cached === undefined ? Number.POSITIVE_INFINITY : nowMs() - cached.loadedAtMs
      if (cached !== undefined && ageMs < ttlMs) {
        // Refresh ahead: the request is answered now; the reload's outcome lands in the cache.
        if (ageMs >= refreshAheadMs) startLoad(digest, prefix, presented)?.catch(() => undefined)
        return cached.key
      }

      const loading = startLoad(digest, prefix, presented)
      if (loading === null) {
        if (cached !== undefined) return cached.key
        throw busy()
      }
      try {
        return await loading
      } catch (error) {
        if (!isStoreFailure(error)) throw error
        // Bounded by the cache itself: the entry is gone `staleOnErrorMs` past its TTL.
        if (cached !== undefined && verified.get(digest) === cached) return cached.key
        throw busy(error)
      }
    },

    invalidate(keyId) {
      generation += 1
      for (const digest of byKeyId.get(keyId) ?? []) verified.delete(digest)
      byKeyId.delete(keyId)
    },

    invalidateAll() {
      generation += 1
      verified.clear()
      refused.clear()
      byKeyId.clear()
    },
  }
}

/** A failure that says nothing about the key: the store could not answer. */
function isStoreFailure(error: unknown): boolean {
  return !(error instanceof KeyRevokedError || error instanceof KeyVerificationUnavailableError)
}

/** A key past its expiry is refused exactly like a revoked one. */
function isExpired(key: VerifiedKey, at: Date): boolean {
  return key.expiresAt !== null && key.expiresAt.getTime() <= at.getTime()
}
