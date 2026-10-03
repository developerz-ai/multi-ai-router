import { isWindowSpent } from "./quota"
import type { AccountSnapshot } from "./types"

export function hasRecoveryPermit(account: AccountSnapshot): boolean {
  return account.recovery?.state === "issued" && account.recovery.localAvailable === true
}
export function recoveryIsGated(account: AccountSnapshot): boolean {
  const state = account.recovery?.state
  return state !== undefined && state !== "succeeded" && state !== "cancelled"
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
