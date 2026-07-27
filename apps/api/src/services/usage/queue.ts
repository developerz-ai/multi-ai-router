/**
 * A bounded in-memory queue that sheds rather than blocks.
 *
 * The rule it exists to enforce: **a slow or unavailable database degrades reporting, never
 * traffic** (docs/idea/08-observability.md). Backpressure onto the request path is exactly what
 * must not happen, so the queue has a hard ceiling and drops the **oldest** records on overflow —
 * the newest are the ones an operator is looking at.
 *
 * Dropped records are counted, not swallowed: `router_usage_records_dropped_total` being non-zero
 * is how "reporting is behind" becomes visible instead of mysterious.
 */

export interface BoundedQueue<T> {
  /** Never blocks, never throws. Returns false when an older item was shed to make room. */
  push(item: T): boolean
  /** Removes and returns up to `max` items, oldest first. */
  drain(max: number): T[]
  readonly depth: number
  /** Total items shed on overflow since construction. Monotonic. */
  readonly dropped: number
}

export function createBoundedQueue<T>(maxItems: number): BoundedQueue<T> {
  if (maxItems < 1) {
    throw new Error(`createBoundedQueue: maxItems must be at least 1, got ${maxItems}`)
  }

  /**
   * A plain array with a moving head: `shift()` on a large array is O(n), and `push` runs on the
   * request path. The head advances instead, and the dead prefix it leaves behind is reclaimed
   * **lazily** — never once per call.
   *
   * Reclaiming eagerly would put an O(n) copy exactly where it must not be: a queue at its ceiling
   * sheds on every push, so every request during a database outage would copy the whole buffer, and
   * the slower the database the more the router charges its own clients for it.
   *
   * The rule instead is *reclaim once the dead prefix is at least as long as the live one*. That
   * costs one copy of n elements per n advances — O(1) amortized — and keeps the array under twice
   * the ceiling. It has to run on `push` as well as on `drain`, because a wedged writer stops
   * draining entirely, and a prefix reclaimed only on drain would then grow with traffic until the
   * process ran out of memory.
   */
  let items: T[] = []
  let head = 0
  let dropped = 0

  const depth = (): number => items.length - head

  const reclaim = (): void => {
    if (head === 0 || head < depth()) return
    items = items.slice(head)
    head = 0
  }

  return {
    push(item) {
      let shed = false
      while (depth() >= maxItems) {
        head += 1
        dropped += 1
        shed = true
      }
      items.push(item)
      reclaim()
      return !shed
    },

    drain(max) {
      const take = Math.min(Math.max(0, max), depth())
      if (take === 0) return []
      const batch = items.slice(head, head + take)
      head += take
      reclaim()
      return batch
    },

    get depth() {
      return depth()
    },

    get dropped() {
      return dropped
    },
  }
}
