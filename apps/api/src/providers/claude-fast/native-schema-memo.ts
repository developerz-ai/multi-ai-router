/**
 * Schemas Anthropic refused natively (or stalled on) in this process, so a repeat of the same
 * `response_format` goes straight to the adapted tool instead of paying the header timeout again
 * (101 finding 10.4). Keyed by a hash of the schema's JSON, bounded, oldest entry out first — a
 * lost entry costs one more timed-out attempt, never a wrong answer. In-memory per replica.
 */
export interface NativeSchemaMemo {
  has(schema: unknown): boolean
  add(schema: unknown): void
}

export function createNativeSchemaMemo(maxEntries: number): NativeSchemaMemo {
  const keys = new Set<bigint>()
  const keyOf = (schema: unknown) => Bun.hash.xxHash64(JSON.stringify(schema) ?? "")
  return {
    has: (schema) => keys.has(keyOf(schema)),
    add: (schema) => {
      const key = keyOf(schema)
      keys.delete(key)
      keys.add(key)
      while (keys.size > maxEntries) {
        const oldest = keys.values().next()
        if (oldest.done) break
        keys.delete(oldest.value)
      }
    },
  }
}
