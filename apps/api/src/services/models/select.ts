import type { AccountCatalogAge, AccountRow } from "@multi-ai-router/db"
import { isRefreshable } from "./refresh"

/**
 * When each Account was last **asked without a write** — a failed or skipped refresh. Held in
 * memory by the sweep, keyed by account id.
 *
 * `refreshed_at` only moves when a listing is written, so on its own it cannot tell "not asked yet"
 * from "asked every tick and never answered". This is the missing half, and it is deliberately not
 * a column: losing it on restart costs one extra ask per such account, and each replica keeping its
 * own is enough to rotate.
 */
export type RefreshAttempts = ReadonlyMap<string, Date>

/**
 * Which Accounts this tick refreshes: the longest-unasked first, capped at the batch.
 *
 * A pure function, and it exists because the obvious version is quietly broken. "Take the first N
 * accounts" refreshes the *same* N every hour and never reaches the rest — the sweep looks healthy,
 * the tally looks full, and account N+1's catalog is however old it was on the day it was added.
 * Ordering by staleness is what makes the batch a rate limit rather than a horizon.
 *
 * **An Account never asked sorts first.** Never-refreshed is more urgent than
 * refreshed-a-while-ago: it is the account whose catalog is missing entirely, usually because it
 * was added since the last tick, and an operator who just connected a provider should see its
 * models on the next tick rather than after every older account has taken a turn.
 *
 * **An Account asked in vain takes its place in the queue like any other.** Its position is the
 * later of its last write and its last attempt. Ordering on the write alone has the same flaw the
 * cap was built to avoid, one level down: an endpoint whose listing always fails never acquires a
 * newer `refreshed_at`, sorts first every tick, and — once a batch's worth of them exist — is the
 * only thing the sweep ever asks.
 *
 * Non-refreshable accounts are filtered *before* the cap, not skipped inside the loop. They are
 * never asked at all, so they would sort first forever and consume the whole batch every tick.
 */
export function selectForRefresh(
  accounts: readonly AccountRow[],
  ages: readonly AccountCatalogAge[],
  limit: number,
  attempts: RefreshAttempts = new Map(),
): readonly AccountRow[] {
  const refreshedAt = new Map(ages.map((age) => [age.accountId, age.refreshedAt.getTime()]))
  const lastAsked = (id: string): number =>
    Math.max(
      refreshedAt.get(id) ?? Number.NEGATIVE_INFINITY,
      attempts.get(id)?.getTime() ?? Number.NEGATIVE_INFINITY,
    )

  return accounts
    .filter(isRefreshable)
    .map((account) => ({ account, at: lastAsked(account.id) }))
    .sort(
      (left, right) =>
        compare(left.at, right.at) || left.account.id.localeCompare(right.account.id),
    )
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.account)
}

/** Subtraction would be `NaN` for two never-asked accounts (`-Infinity - -Infinity`). */
function compare(left: number, right: number): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}
