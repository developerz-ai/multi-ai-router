import { isWindowSpent } from "./quota"
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
