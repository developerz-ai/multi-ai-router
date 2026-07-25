import type { SessionLineageState } from "@multi-ai-router/db"

/**
 * The two caches in front of the `sessions` table, and the eviction rule that keeps them agreeing.
 *
 * | Cache | Key | Serves |
 * |---|---|---|
 * | session | `apiKeyId` + the client's session key | clients that name their conversation |
 * | fingerprint | `accountId` + `sha256(cwd + first user text)` | headerless clients |
 *
 * **Postgres is the persisted truth; this is the cache** (docs/idea/11-anthropic-agent-sdk.md §4).
 * An SDK session id resumes only on the Account that minted it, so the binding is a fact about
 * where a conversation physically lives — not a routing preference a cache may invent. Everything
 * here is therefore either a copy of a row or an alias pointing at one, and a cold replica simply
 * re-reads the table.
 *
 * **Coordinated eviction is the invariant.** Dropping an entry from one cache removes every entry
 * in the other naming the same SDK session id. Without it a half-evicted pair resurrects a session
 * the other cache abandoned: the fingerprint side has no backing row to re-read, so it would hand
 * out a resume token for a lineage nobody remembers, and the next turn would splice two histories.
 *
 * Misses are cached too, with their own shorter TTL. A router holding one subscription Account
 * still serves plain HTTP traffic whose sessions will never have a row, and re-asking Postgres for
 * every one of them is exactly the per-request query the performance budget forbids.
 */

/** A binding worth honoring: an Account *and* the session id that only resumes there. */
export interface SessionEntry {
  readonly accountId: string
  readonly sdkSessionId: string
  readonly lineage: SessionLineageState
}

/** `undefined` — never looked up. `null` — looked up, and this session has no binding. */
export type CachedSession = SessionEntry | null | undefined

export interface SessionCacheOptions {
  readonly maxEntries: number
  /** How long a binding is reused before the row is re-read. Bounds cross-replica staleness. */
  readonly ttlMs: number
  /** How long "this session has no binding" is remembered. Shorter: a binding may appear. */
  readonly negativeTtlMs: number
  /** Monotonic-enough milliseconds. Injected so every expiry test runs without waiting. */
  readonly now?: () => number
}

export interface SessionCache {
  get(key: string): CachedSession
  set(key: string, entry: SessionEntry | null): void
  /** Invalidation: this key's binding is gone, and so is everything naming its session id. */
  drop(key: string): void
  /** Points a fingerprint at the session key that owns the binding. */
  alias(fingerprint: string, key: string): void
  /** The session key a fingerprint resolves to, if one is still cached. */
  aliased(fingerprint: string): string | undefined
  /** The SDK reported this session gone. Every entry naming it goes, from both caches. */
  forget(sdkSessionId: string): void
  readonly size: number
  readonly aliases: number
}

interface Entry {
  readonly value: SessionEntry | null
  readonly expiresAtMs: number
}

interface Alias {
  readonly key: string
  readonly sdkSessionId: string
  readonly expiresAtMs: number
}

/** Every name pointing at one SDK session id, so eviction can take all of them together. */
interface Named {
  readonly keys: Set<string>
  readonly fingerprints: Set<string>
}

export function createSessionCache(options: SessionCacheOptions): SessionCache {
  if (options.maxEntries < 1) {
    throw new Error(`createSessionCache: maxEntries must be at least 1, got ${options.maxEntries}`)
  }

  const now = options.now ?? Date.now
  // Insertion order is Map's own contract; re-inserting on a hit is what makes eviction LRU.
  const entries = new Map<string, Entry>()
  const aliases = new Map<string, Alias>()
  const named = new Map<string, Named>()

  const link = (sdkSessionId: string): Named => {
    const existing = named.get(sdkSessionId)
    if (existing !== undefined) return existing
    const fresh: Named = { keys: new Set(), fingerprints: new Set() }
    named.set(sdkSessionId, fresh)
    return fresh
  }

  /**
   * The coordinated part. Both maps are cleared of this session id before either is re-read, so
   * no caller can observe one side without the other.
   */
  const purge = (sdkSessionId: string): void => {
    const group = named.get(sdkSessionId)
    if (group === undefined) return
    named.delete(sdkSessionId)
    for (const key of group.keys) entries.delete(key)
    for (const fingerprint of group.fingerprints) aliases.delete(fingerprint)
  }

  /** Forgets one name without disturbing its siblings. Used when a name is simply overwritten. */
  const unlink = (sdkSessionId: string, from: "keys" | "fingerprints", name: string): void => {
    const group = named.get(sdkSessionId)
    if (group === undefined) return
    group[from].delete(name)
    if (group.keys.size === 0 && group.fingerprints.size === 0) named.delete(sdkSessionId)
  }

  const evictOldestEntry = (): void => {
    const oldest = entries.keys().next()
    if (oldest.done) return
    const value = entries.get(oldest.value)?.value
    entries.delete(oldest.value)
    if (value !== undefined && value !== null) purge(value.sdkSessionId)
  }

  const evictOldestAlias = (): void => {
    const oldest = aliases.keys().next()
    if (oldest.done) return
    const alias = aliases.get(oldest.value)
    aliases.delete(oldest.value)
    if (alias !== undefined) purge(alias.sdkSessionId)
  }

  return {
    get(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      if (entry.expiresAtMs <= now()) {
        entries.delete(key)
        if (entry.value !== null) purge(entry.value.sdkSessionId)
        return undefined
      }
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },

    set(key, value) {
      // Replacing a key's own value is not an eviction: only a *different* session id leaving this
      // key means the old one lost its last name here, so only that case purges.
      const previous = entries.get(key)?.value ?? null
      entries.delete(key)
      if (previous !== null && previous.sdkSessionId !== value?.sdkSessionId) {
        unlink(previous.sdkSessionId, "keys", key)
        purge(previous.sdkSessionId)
      }

      while (entries.size >= options.maxEntries) evictOldestEntry()
      const ttl = value === null ? options.negativeTtlMs : options.ttlMs
      entries.set(key, { value, expiresAtMs: now() + ttl })
      if (value !== null) link(value.sdkSessionId).keys.add(key)
    },

    drop(key) {
      const value = entries.get(key)?.value ?? null
      entries.delete(key)
      if (value !== null) purge(value.sdkSessionId)
    },

    alias(fingerprint, key) {
      const target = entries.get(key)?.value ?? null
      // An alias with nothing to point at would resolve to a key with no entry — a guaranteed
      // miss that still occupies a slot, and one more name to keep coordinated for nothing.
      if (target === null) return

      const previous = aliases.get(fingerprint)
      aliases.delete(fingerprint)
      if (previous !== undefined && previous.sdkSessionId !== target.sdkSessionId) {
        unlink(previous.sdkSessionId, "fingerprints", fingerprint)
        purge(previous.sdkSessionId)
      }

      while (aliases.size >= options.maxEntries) evictOldestAlias()
      aliases.set(fingerprint, {
        key,
        sdkSessionId: target.sdkSessionId,
        expiresAtMs: now() + options.ttlMs,
      })
      link(target.sdkSessionId).fingerprints.add(fingerprint)
    },

    aliased(fingerprint) {
      const alias = aliases.get(fingerprint)
      if (alias === undefined) return undefined
      if (alias.expiresAtMs <= now()) {
        aliases.delete(fingerprint)
        purge(alias.sdkSessionId)
        return undefined
      }
      aliases.delete(fingerprint)
      aliases.set(fingerprint, alias)
      return alias.key
    },

    forget: purge,

    get size() {
      return entries.size
    },

    get aliases() {
      return aliases.size
    },
  }
}
