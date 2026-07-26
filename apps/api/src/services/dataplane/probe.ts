import type { Candidate } from "../routing"
import type { HealthStore } from "./health"

/**
 * The half-open probe gate, as the failover chain sees it.
 *
 * `filter.ts` labels an account whose cooldown has expired a **probe** and the policies rank it
 * behind every healthy account — but a label is not a gate. Until this existed, "one request is
 * allowed through as a probe" was a sentence in the spec that nothing implemented: the reset
 * instant passing made the account eligible to every in-flight request simultaneously, so the
 * backlog that built up during a five-minute cooldown dispatched onto the recovering account all
 * at once, in the same millisecond, and rate-limited it again before it answered any of them.
 *
 * Three properties make it a gate rather than a queue:
 *
 * 1. **It is taken at attempt time, not at selection time.** A probe demoted to third place is
 *    usually never reached; taking its hold when it was merely *ordered* would park a recovering
 *    account behind requests that never touch it.
 * 2. **A refusal costs nothing.** The chain drops the candidate and walks on — no attempt spent, no
 *    `UsageRecord` written, no upstream contacted. Nothing happened to that account.
 * 3. **The hold is visible in the next snapshot.** Every request that selects *after* it was taken
 *    is dropped by the pure filter as `probe-in-flight` — a `429` carrying the hold's expiry, which
 *    is the honest answer for something a clock fixes in milliseconds.
 *
 * The operator's **Re-check now** joins the same gate rather than adding a path beside it:
 * `services/accounts/recheck.ts` clears the account's marks — the hold among them — so the next
 * request becomes the probe and the ones behind it wait for its verdict.
 */

export interface HalfOpenProbe {
  /** False when another request is already testing this account. Drop the candidate; do not queue. */
  readonly admitted: boolean
  /** Idempotent, and a no-op unless this caller actually took the hold. */
  release(): void
}

const NOTHING_TO_RELEASE = (): void => undefined
const NOT_A_PROBE: HalfOpenProbe = { admitted: true, release: NOTHING_TO_RELEASE }

/**
 * Asks the gate whether this attempt may proceed. A healthy candidate is admitted untouched — only
 * a half-open one is gated, and only it owes a {@link HalfOpenProbe.release}.
 */
export function admitHalfOpenProbe(
  health: Pick<HealthStore, "admitProbe" | "releaseProbe">,
  candidate: Candidate,
  now: Date,
): HalfOpenProbe {
  if (!candidate.halfOpen) return NOT_A_PROBE

  const accountId = candidate.account.id
  const admission = health.admitProbe(accountId, now)
  return {
    admitted: admission.admitted,
    release: admission.held ? () => health.releaseProbe(accountId) : NOTHING_TO_RELEASE,
  }
}
