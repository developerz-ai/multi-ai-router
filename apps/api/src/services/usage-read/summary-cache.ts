/**
 * Coalesces identical usage summaries.
 *
 * One summary is ~20 aggregates over the windowed facts and raw rows (140-490 ms each in prod,
 * 2026-11). Two operators, or one double refresh, used to run the whole set twice on two pool
 * connections. Identical `(query, filter)` reads now share the in-flight promise, and a settled
 * answer is reused for `ttlMs` (0 = single-flight only). A rejection is never kept.
 */

/** Distinct entries kept at once; a console asks for a handful of windows, not hundreds. */
const MAX_ENTRIES = 64

interface Entry<T> {
  readonly promise: Promise<T>
  /** Epoch ms after which a settled answer is stale; `Infinity` while in flight. */
  expiresAt: number
}

export interface SummaryCache<T> {
  read(key: string, load: () => Promise<T>): Promise<T>
}

export function createSummaryCache<T>(ttlMs: number, now: () => Date): SummaryCache<T> {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("summary cache ttl must be >= 0")
  const entries = new Map<string, Entry<T>>()

  return {
    read(key, load) {
      const at = now().getTime()
      const found = entries.get(key)
      if (found !== undefined && found.expiresAt > at) return found.promise
      for (const [stale, entry] of entries) if (entry.expiresAt <= at) entries.delete(stale)
      if (entries.size >= MAX_ENTRIES) {
        const oldest = entries.keys().next()
        if (oldest.done !== true) entries.delete(oldest.value)
      }
      const entry: Entry<T> = { promise: load(), expiresAt: Number.POSITIVE_INFINITY }
      entries.set(key, entry)
      entry.promise.then(
        () => {
          entry.expiresAt = now().getTime() + ttlMs
          if (ttlMs === 0 && entries.get(key) === entry) entries.delete(key)
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key)
        },
      )
      return entry.promise
    },
  }
}

/** A key independent of property order, so `{a,b}` and `{b,a}` coalesce. */
export function summaryKey(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => (left < right ? -1 : 1)))
      : inner,
  )
}
