/**
 * A bounded TTL cache with least-recently-used eviction.
 *
 * Key verification is on the hot path of every data-plane request, and the performance budget is
 * explicit that **nothing touches Postgres there** — a verified key is answered from memory, and a
 * miss costs one indexed query (docs/idea/01-architecture.md, performance budget). This is that
 * memory, and it is bounded so a spray of unknown keys cannot grow it without limit.
 *
 * The clock is injected, so every expiry test runs without waiting.
 */

export interface TtlCacheOptions {
  readonly maxEntries: number
  readonly ttlMs: number
  readonly now?: () => number
}

export interface TtlCache<V> {
  get(key: string): V | undefined
  /** `ttlMs` overrides the cache default for this entry only. */
  set(key: string, value: V, ttlMs?: number): void
  delete(key: string): void
  clear(): void
  readonly size: number
}

interface Entry<V> {
  readonly value: V
  readonly expiresAtMs: number
}

export function createTtlCache<V>(options: TtlCacheOptions): TtlCache<V> {
  if (options.maxEntries < 1) {
    throw new Error(`createTtlCache: maxEntries must be at least 1, got ${options.maxEntries}`)
  }

  const now = options.now ?? Date.now
  // Insertion order is Map's own contract; re-inserting on a hit is what makes eviction LRU
  // rather than FIFO.
  const entries = new Map<string, Entry<V>>()

  const evictOldest = (): void => {
    const oldest = entries.keys().next()
    if (!oldest.done) entries.delete(oldest.value)
  }

  return {
    get(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      if (entry.expiresAtMs <= now()) {
        entries.delete(key)
        return undefined
      }
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },

    set(key, value, ttlMs) {
      entries.delete(key)
      while (entries.size >= options.maxEntries) evictOldest()
      entries.set(key, { value, expiresAtMs: now() + (ttlMs ?? options.ttlMs) })
    },

    delete(key) {
      entries.delete(key)
    },

    clear() {
      entries.clear()
    },

    get size() {
      return entries.size
    },
  }
}
