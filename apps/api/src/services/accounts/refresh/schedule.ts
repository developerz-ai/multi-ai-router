/**
 * When an account's next refresh is due. Pure arithmetic over an expiry and a clock — no timers, no
 * store, no account (CLAUDE.md non-negotiable 9), so every rule below is testable by calling it.
 *
 * **A fraction of the remaining lifetime, not a fixed lead.** A fixed "refresh 5 minutes early" is
 * either wasteful against a 24-hour token or already too late against a 10-minute one; a fraction is
 * correct for both and is what `docs/idea/01-architecture.md#credential-refresh-is-not-a-cron-job`
 * asks for. `leadFraction` is the share of the remaining lifetime that is allowed to elapse first,
 * so `0.75` refreshes with a quarter of the lifetime still in hand.
 *
 * **The floor is what stops a spin.** A token that is already expired, or nearly so, computes a lead
 * of zero or less. Without a floor the timer would fire, fail, re-arm at zero, and hammer the
 * provider; with one the worst case is one attempt per `minDelayMs`.
 */

export interface RefreshTiming {
  /** Share of the remaining lifetime allowed to elapse before refreshing. 0..1. */
  readonly leadFraction: number
  /** Floor on any delay this module produces, and the first step of the retry backoff. */
  readonly minDelayMs: number
}

/**
 * `setTimeout`'s ceiling. A larger delay wraps to a near-immediate fire, which for a year-long token
 * would be a hot loop rather than a long wait — so a due instant beyond this is armed in slices.
 */
export const MAX_TIMER_MS = 2_147_483_647

/** The instant a refresh should run, given when the current token dies. */
export function refreshDueAt(expiresAt: Date, now: Date, timing: RefreshTiming): Date {
  const remainingMs = expiresAt.getTime() - now.getTime()
  const lead = remainingMs * timing.leadFraction
  return new Date(now.getTime() + Math.max(lead, timing.minDelayMs))
}

/**
 * Backoff for consecutive transient failures: the floor, doubling. `attempt` is 1-based, so the
 * first retry waits exactly `minDelayMs` — the same floor everything else in this module respects,
 * rather than a second knob that could be tuned into disagreeing with it.
 */
export function retryDelayMs(attempt: number, minDelayMs: number): number {
  const doubled = minDelayMs * 2 ** Math.max(attempt - 1, 0)
  return Math.min(doubled, MAX_TIMER_MS)
}

/** What to hand `setTimeout`: never negative, never past what a timer can express. */
export function timerDelayMs(dueAtMs: number, nowMs: number): number {
  return Math.min(Math.max(dueAtMs - nowMs, 0), MAX_TIMER_MS)
}
