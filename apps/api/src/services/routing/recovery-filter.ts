import { findSpentWindow, isWindowSpent } from "./quota"
import type { AccountSnapshot } from "./types"

export function hasRecoveryPermit(account: AccountSnapshot): boolean {
  return account.recovery?.state === "issued" && account.recovery.localAvailable === true
}
export function recoveryIsGated(account: AccountSnapshot): boolean {
  const state = account.recovery?.state
  return state !== undefined && state !== "succeeded" && state !== "cancelled"
}
/**
 * Background turns (keepalive, idle probe) stay off an account only while its recovery may still
 * have a call on the wire. Mirrors the durable `background-account-eligibility.ts` predicate.
 */
export function recoveryBlocksBackground(account: AccountSnapshot, now: Date): boolean {
  const recovery = account.recovery
  if (recovery === undefined) return false
  if (recovery.state === "issued") return true
  return (
    (recovery.state === "failed" || recovery.state === "uncertain") &&
    recovery.nextAllowedAt.getTime() > now.getTime()
  )
}
/**
 * A failed or uncertain recovery whose own `nextAllowedAt` has passed, on an account nothing else
 * holds out: usable status, no breaker clock still running, no spent window. Only a new probe clears
 * that gate, and with no client traffic none arrives, so the router opens one itself
 * (`dataplane/recovery-probe.ts`). A spent window or a running clock is left to that clock: probing
 * through it would spend a request the provider already said it will refuse.
 */
export function recoveryAwaitsProbe(
  account: AccountSnapshot,
  now: Date,
  threshold: number,
): boolean {
  const recovery = account.recovery
  if (recovery?.state !== "failed" && recovery?.state !== "uncertain") return false
  if (recovery.nextAllowedAt.getTime() > now.getTime()) return false
  if (account.status !== "active" && account.status !== "cooling_down") return false
  const until = account.health.cooldownUntil
  if (until !== undefined && until.getTime() > now.getTime()) return false
  return findSpentWindow(account, now, threshold) === null
}
/** Only the exact captured persisted evidence may be bypassed by the designated permit. */
export function recoveryAllowsQuota(
  account: AccountSnapshot,
  now: Date,
  threshold: number,
): boolean {
  if (!hasRecoveryPermit(account)) return false
  return (account.quotaWindows ?? []).every(
    (window) =>
      !isWindowSpent(window, now, threshold) ||
      (window.revision !== undefined &&
        account.recovery?.quotaRevisions[window.window] === window.revision),
  )
}
