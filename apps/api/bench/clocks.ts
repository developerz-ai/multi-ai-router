/**
 * The two numbers the bench reports, as arithmetic over timestamps and nothing else.
 *
 * Pure on purpose: `drive.ts` takes the readings around a real request, and this file decides what
 * they mean. That split is what lets a test hand it a request with known timestamps and assert the
 * exact answer — a driver that charged the upstream's whole wait to the router would otherwise pass
 * every live test, which only ever see "some positive number".
 *
 * All readings are `performance.now()` milliseconds from one process.
 */

export interface RequestClocks {
  /** The client sent the request. */
  readonly startedAt: number
  /** The client read the last byte of the response. */
  readonly endedAt: number
  /** The router called the upstream. Zero when it never did. */
  readonly upstreamEnteredAt: number
  /** The upstream released its first byte. */
  readonly upstreamFirstByteAt: number
  /** The upstream released its last byte. Zero when it never finished. */
  readonly upstreamLastByteAt: number
  /** The client read its first byte. Zero for a non-streamed response, or one that sent nothing. */
  readonly clientFirstByteAt: number
  /** When the upstream released stream token N (`tok<N> `). Sparse where a token was never sent. */
  readonly upstreamTokenAt: readonly (number | undefined)[]
  /** When the client read the chunk carrying stream token N. Sparse likewise. */
  readonly clientTokenAt: readonly (number | undefined)[]
}

/**
 * How late the router made this request, in ms: what a client waited beyond what the upstream took.
 *
 * Three places a router can add time, and the request is as late as the worst of the last two on
 * top of the first:
 *
 * - **before the upstream** — auth, the body scan, selection, translating the request. The upstream
 *   has not started, so every later byte is this much late.
 * - **between chunks** — the relay and the per-chunk translation. Each token is late by the gap
 *   between the upstream releasing it and the client reading it. Subtracting the upstream's whole
 *   span from the request's wall time cannot see this at all: work that finishes before the next
 *   chunk arrives does not lengthen the request, it only delays the token it was done on.
 * - **after the upstream's last byte** — the tail of the relay, a non-streamed answer's
 *   observation and re-serialization, settlement.
 *
 * Lateness, not CPU: the per-token delays are not summed, because a client does not wait for them
 * in series. Null when the request never reached the upstream — there is no wait to subtract, and
 * it is a failure already.
 */
export function overheadMs(clocks: RequestClocks): number | null {
  if (clocks.upstreamEnteredAt === 0 || clocks.upstreamLastByteAt === 0) return null
  const before = clocks.upstreamEnteredAt - clocks.startedAt
  const after = clocks.endedAt - clocks.upstreamLastByteAt
  return Math.max(0, before + Math.max(after, worstTokenDelayMs(clocks)))
}

/** The latest any stream token reached the client after the upstream released it. Zero for none. */
export function worstTokenDelayMs(clocks: RequestClocks): number {
  let worst = 0
  for (const [index, released] of clocks.upstreamTokenAt.entries()) {
    const read = clocks.clientTokenAt[index]
    if (released === undefined || read === undefined) continue
    worst = Math.max(worst, read - released)
  }
  return worst
}

/**
 * Added time-to-first-token, ms: how long the client waited for its first byte, less how long the
 * upstream took to produce one once it was asked.
 *
 * From the request's start, not from the upstream's first byte. Measured from the upstream's first
 * byte, everything the router does *before* it calls the upstream — which is most of what it does —
 * is invisible: a router that spent 3 ms deciding where to send a request would add 3 ms to every
 * first token and report zero. Null when no first byte was timed.
 */
export function addedTtftMs(clocks: RequestClocks): number | null {
  if (clocks.clientFirstByteAt === 0 || clocks.upstreamEnteredAt === 0) return null
  const clientWaited = clocks.clientFirstByteAt - clocks.startedAt
  const upstreamTook = clocks.upstreamFirstByteAt - clocks.upstreamEnteredAt
  return clientWaited - upstreamTook
}

/** The stream tokens a chunk of text carries: `tok7 ` → 7. The stub writes them, the driver reads them. */
export function tokensIn(text: string): number[] {
  const found: number[] = []
  for (const match of text.matchAll(/tok(\d+) /g)) found.push(Number(match[1]))
  return found
}
