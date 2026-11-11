/** The two buckets a decaying `recentTokens` sums (`health.ts`, plan 101 02.10). */
export interface TokenWindow {
  /** Monotonic ms the current bucket opened at. */
  readonly start: number
  readonly previous: number
  readonly current: number
}

/** Rotates the two buckets to `now`; returns the same object when nothing rotated. */
export function rotateTokens(window: TokenWindow, now: number, widthMs: number): TokenWindow {
  const age = now - window.start
  if (age < widthMs) return window
  if (age < 2 * widthMs)
    return { start: window.start + widthMs, previous: window.current, current: 0 }
  return { start: now, previous: 0, current: 0 }
}
