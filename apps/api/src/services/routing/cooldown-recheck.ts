import { isWindowSpent } from "./quota"
import type { AccountSnapshot } from "./types"

/**
 * Whether the hourly recheck should look at this account, as a pure read of its live snapshot.
 *
 * `status` here is the overlaid one, so a verdict the breaker holds in memory counts as well as a
 * stored one: `exhausted` (non-negotiable 7), `needs_reauth` and `disabled` never pass, because no
 * clock is what they are waiting for. A refused key has its own doubling re-test clock
 * (`credential-rejection.ts`), and a second one would step past the wait it earned.
 *
 * An account whose block clears inside `horizonMs` is left to its reset: the half-open probe gets
 * there before the next tick would, and a recheck would only spend a request to learn less.
 */
export function cooldownRecheckDue(
  account: AccountSnapshot,
  now: Date,
  horizonMs: number,
  threshold: number,
): boolean {
  if (account.status !== "active" && account.status !== "cooling_down") return false
  if (account.health.cooldownReason === "credential-rejected") return false

  const held = account.health.cooldownUntil
  const running = held !== undefined && held.getTime() > now.getTime()
  const spent = (account.quotaWindows ?? []).filter((window) =>
    isWindowSpent(window, now, threshold),
  )
  const noStatedEnd =
    (account.status === "cooling_down" && held === undefined) ||
    spent.some((window) => window.resetsAt === undefined)
  if (noStatedEnd) return true
  if (!running && spent.length === 0) return false

  const clearsAt = Math.max(
    running ? held.getTime() : 0,
    ...spent.map((window) => window.resetsAt?.getTime() ?? 0),
  )
  return clearsAt - now.getTime() > horizonMs
}

/** Evidence a fresh reading opened the account: a window was re-read, and none of them is spent. */
export function readingReopened(
  before: AccountSnapshot,
  after: AccountSnapshot,
  now: Date,
  threshold: number,
): boolean {
  const windows = after.quotaWindows ?? []
  const reread = windows.some((window) => {
    const held = before.quotaWindows?.find((prior) => prior.window === window.window)
    return held === undefined || window.lastCheckedAt.getTime() > held.lastCheckedAt.getTime()
  })
  return reread && !windows.some((window) => isWindowSpent(window, now, threshold))
}

/**
 * A current, provider-reported window is spent with its reset still ahead. A recheck answering 2xx
 * does not reopen such an account: the probe model answered, which says nothing about a window the
 * provider charges to other models (plan 101, 10.8 — opencode-go seats reopened 51 times in 37.5 h
 * against a weekly window at 1.0, each reopening followed by real `429`s). Only a fresh reading
 * that lifts the window, or its own reset, reopens it.
 */
export function providerReportedSpent(
  account: AccountSnapshot,
  now: Date,
  threshold: number,
): boolean {
  return (account.quotaWindows ?? []).some(
    (window) =>
      window.resetSource === "provider-reported" &&
      window.resetsAt !== undefined &&
      window.resetsAt.getTime() > now.getTime() &&
      isWindowSpent(window, now, threshold),
  )
}
