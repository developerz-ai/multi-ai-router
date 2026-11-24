import type { StreamDeadlines } from "./upstream-deadline"

/**
 * How long one request may keep its client without a status line because upstreams answered headers
 * and then nothing (`success-wall.ts`), summed over the whole chain.
 *
 * Holding past `wallHoldMs` buys failover, and a single silent account is worth the wait: its own
 * idle clock ends it and a sibling serves. Added up per account it is not: three were 165 s with no
 * headers at the 55 s default, past an edge's ~100 s header timeout, so a request the third account
 * would have served slowly was answered by the edge.
 *
 * The budget is the silence past the wall hold that one idle clock allows, so the first silent
 * account spends exactly all of it; whoever is silent next commits at the wall hold, as any silent
 * upstream did before. Head time on a silent chain is therefore one idle clock plus one wall hold.
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
