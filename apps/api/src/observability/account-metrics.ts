import { AccountStatus } from "@multi-ai-router/core"
import type { AccountMetric } from "./metric-types"
import type { RouterSeries } from "./series"

const BREAKER_PHASES = ["closed", "open", "half-open", "blocked"] as const
export function setAccountMetrics(
  s: RouterSeries,
  accounts: readonly AccountMetric[],
  now: () => Date,
): void {
  s.accounts.clear()
  s.quotaUtilization.clear()
  s.quotaReset.clear()
  s.quotaLastChecked.clear()
  s.breakerState.clear()
  s.credentialRejected.clear()
  const at = now().getTime()

  const counts = new Map<string, number>()
  for (const account of accounts) {
    const key = `${account.provider} ${account.status}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    setQuota(s, account, at)
    for (const phase of BREAKER_PHASES) {
      s.breakerState.set({ account_id: account.id, phase }, phase === account.breakerPhase ? 1 : 0)
    }
    s.credentialRejected.set({ account_id: account.id }, account.credentialRejected ? 1 : 0)
  }
  // Every status of every provider present, zeros included: an alert on `exhausted` must see
  // the number fall to zero, not watch the series vanish.
  for (const provider of new Set(accounts.map((account) => account.provider))) {
    for (const status of AccountStatus.options) {
      s.accounts.set({ provider, status }, counts.get(`${provider} ${status}`) ?? 0)
    }
  }
}
/**
 * An `exhausted` account has no reset to report, so `router_quota_reset_seconds` is absent for it
 * rather than zero — a countdown of zero reads as "back any second now", which is the opposite of
 * what a drained balance means.
 */
function setQuota(s: RouterSeries, account: AccountMetric, at: number): void {
  let lastChecked: number | null = null
  for (const state of account.quotaWindows ?? []) {
    const account_id = account.id
    const window = state.window
    if (state.utilization !== undefined) {
      s.quotaUtilization.set({ account_id, window }, state.utilization)
    }
    if (state.resetsAt !== undefined && account.status !== "exhausted") {
      const seconds = Math.max(0, (state.resetsAt.getTime() - at) / 1_000)
      s.quotaReset.set({ account_id, window, source: state.resetSource }, seconds)
    }
    const checkedAt = state.lastCheckedAt.getTime()
    lastChecked = lastChecked === null ? checkedAt : Math.max(lastChecked, checkedAt)
  }
  if (lastChecked !== null) s.quotaLastChecked.set({ account_id: account.id }, lastChecked / 1_000)
}
