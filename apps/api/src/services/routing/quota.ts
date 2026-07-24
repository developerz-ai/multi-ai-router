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
 */
export function continuousHeadroom(account: AccountSnapshot): number | null {
  let peakUtilization: number | null = null

  for (const window of account.quotaWindows ?? []) {
    if (window.utilizationSource !== "continuous") continue
    if (window.utilization === undefined) continue
    if (peakUtilization === null || window.utilization > peakUtilization) {
      peakUtilization = window.utilization
    }
  }

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
