/**
 * Quota window math.
 *
 * Two jobs, and the difference between them is the whole point of `utilizationSource`:
 *
 * - **Filtering** asks "is any window spent?". Any signal answers that, including a
 *   threshold-triggered alarm — it fires precisely when the answer is yes.
 * - **Ranking** asks "which account has the most headroom left?". Only a **continuous** signal
 *   answers that. A threshold-triggered source reads nothing for most of a window by design, so
 *   ranking on it is ranking on an absence.
 *
 * `quota-aware` may only ever call {@link continuousHeadroom}, and it must say so when the answer
 * is `null` for everyone.
 */

import type { QuotaWindowState } from "@multi-ai-router/core"
import type { AccountSnapshot } from "./types"

/** Utilization at or above which a window counts as spent, unless the caller overrides it. */
export const DEFAULT_QUOTA_SPENT_THRESHOLD = 1

/**
 * A window is spent when its utilization reached the threshold *and* it has not refilled yet.
 * A reported reset that is already in the past means the window came back — the router does not
 * sit on a stale clock it computed for itself.
 */
export function isWindowSpent(
  window: QuotaWindowState,
  now: Date,
  threshold = DEFAULT_QUOTA_SPENT_THRESHOLD,
): boolean {
  if (window.utilization === undefined) return false
  if (window.utilization < threshold) return false
  if (window.resetsAt !== undefined && window.resetsAt.getTime() <= now.getTime()) return false
  return true
}

/** The first spent window blocking this account, or null. The account is blocked by whichever. */
export function findSpentWindow(
  account: AccountSnapshot,
  now: Date,
  threshold = DEFAULT_QUOTA_SPENT_THRESHOLD,
): QuotaWindowState | null {
  for (const window of account.quotaWindows ?? []) {
    if (isWindowSpent(window, now, threshold)) return window
  }
  return null
}

/**
 * Remaining headroom in `[0, 1]`, from **continuous** readings only, or `null` when the account
 * exposes none. Null is a normal reading, not a fault — and it is also the reading that makes
 * `quota-aware` meaningless, which is why the policy reports it rather than swallowing it.
 *
 * The account is blocked by whichever window is most consumed, so headroom is `1 - max(util)`.
 *
 * **Both vocabularies count.** A named quota window and an HTTP limiter answer the same question
 * about the same credential; they differ only in whether the provider's word for the window maps
 * onto a `QuotaWindowKind`. Reading only the named ones would mean `quota-aware` ranked nothing on
 * every API-key account in the fleet — the accounts that actually publish a continuous reading —
 * and silently degraded to round-robin for the pools most able to use it.
 */
export function continuousHeadroom(account: AccountSnapshot): number | null {
  let peakUtilization: number | null = null

  const observe = (reading: {
    readonly utilization?: number
    readonly utilizationSource: string
  }): void => {
    if (reading.utilizationSource !== "continuous") return
    if (reading.utilization === undefined) return
    if (peakUtilization === null || reading.utilization > peakUtilization) {
      peakUtilization = reading.utilization
    }
  }

  for (const window of account.quotaWindows ?? []) observe(window)
  for (const limiter of account.limiterWindows ?? []) observe(limiter)

  return peakUtilization === null ? null : 1 - peakUtilization
}

/** The soonest reset across a set of windows — what a `429` puts in `Retry-After`. */
export function earliestReset(windows: readonly (Date | undefined)[]): Date | undefined {
  let earliest: Date | undefined
  for (const candidate of windows) {
    if (candidate === undefined) continue
    if (earliest === undefined || candidate.getTime() < earliest.getTime()) earliest = candidate
  }
  return earliest
}

/**
 * Two sets of windows folded into one, per kind: **the fresher `lastCheckedAt` wins**, and a kind
 * neither names is left standing.
 *
 * One rule covering both places windows meet, because it is the same question both times.
 *
 * - Folding a reading into the store, `incoming` is this instant's and always wins. What it did
 *   *not* name survives: a turn that reported `five_hour` said nothing about `seven_day`, and
 *   reading that silence as a refill hands routing an account a seven-day window still blocks.
 * - Overlaying live state on the catalog's rows, freshness decides rather than provenance. A
 *   stored row can genuinely be newer — another replica observed it, or the quota floor cleared an
 *   expired one (`scheduler/tasks/quota-floor.ts`) — and a live reading from hours ago would
 *   otherwise re-assert a utilization the floor deliberately retired.
 *
 * `undefined` is a provider saying nothing about named windows (every HTTP driver, every response)
 * and leaves the set untouched; `[]` would be the different claim that there are none. Order is the
 * incumbent's, so a console rendering four rows does not reshuffle them because a `seven_day` event
 * happened to arrive first.
 */
export function mergeQuotaWindows(
  held: readonly QuotaWindowState[],
  incoming: readonly QuotaWindowState[] | undefined,
): readonly QuotaWindowState[] {
  if (incoming === undefined || incoming.length === 0) return held
  if (held.length === 0) return incoming

  const fresh = new Map(incoming.map((window) => [window.window, window]))
  const merged = held.map((window) => {
    const candidate = fresh.get(window.window)
    if (candidate === undefined) return window
    return candidate.lastCheckedAt >= window.lastCheckedAt ? candidate : window
  })
  for (const window of incoming) {
    if (!held.some((existing) => existing.window === window.window)) merged.push(window)
  }
  return merged
}
