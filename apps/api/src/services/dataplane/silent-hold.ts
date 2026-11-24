import type { StreamDeadlines } from "./upstream-deadline"

/**
 * How long one request may hold an attempt uncommitted because upstreams answered headers and then
 * nothing (`success-wall.ts`), summed over the whole chain.
 *
 * Holding past `wallHoldMs` buys failover, and a single silent account is worth the wait: its own
 * idle clock ends it and a sibling serves. Added up per account it is not: three were 165 s at the
 * 55 s default.
 *
 * **Committing is not a head on the wire.** Bun.serve sends a complete header block only with the
 * first body byte, so a client of a committed, still silent stream waits on: two idle clocks at most
 * (about 110 s at the default). Only a body byte of the router's own would change that, and a
 * passthrough stream gets none (non-negotiable 10).
 *
 * The budget is the silence past the wall hold that one idle clock allows, so the first silent
 * account spends exactly all of it; whoever is silent next commits at the wall hold, as any silent
 * upstream did before: the commit comes after one idle clock and one wall hold.
 * Only silence past the wall hold is charged: an ordinary first byte spends nothing.
 */
export interface SilentHold {
  /** What is left; `undefined` while untouched, when the idle clock itself is the bound. */
  remainingMs(): number | undefined
  spend(milliseconds: number): void
}

export function createSilentHold(clocks: StreamDeadlines): SilentHold {
  const totalMs = Math.max(0, clocks.idleMs - clocks.wallHoldMs)
  let spentMs = 0
  return {
    remainingMs: () => (spentMs === 0 ? undefined : Math.max(0, totalMs - spentMs)),
    spend(milliseconds) {
      spentMs += Math.max(0, milliseconds)
    },
  }
}
