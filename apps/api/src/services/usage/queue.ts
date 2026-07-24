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

  // A plain array with a moving head: shift() on a large array is O(n), and this runs on the
  // request path. The head advances instead, and the buffer is compacted on drain.
  let items: T[] = []
  let head = 0
  let dropped = 0

  const depth = (): number => items.length - head

  const compact = (): void => {
    if (head === 0) return
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
      compact()
      items.push(item)
      return !shed
    },

    drain(max) {
      const take = Math.min(Math.max(0, max), depth())
      if (take === 0) return []
      const batch = items.slice(head, head + take)
      head += take
      compact()
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
