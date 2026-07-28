import type { AccountCatalogAge, AccountRow } from "@multi-ai-router/db"
import { isRefreshable } from "./refresh"

/**
 * Which Accounts this tick refreshes: the most stale first, capped at the batch.
 *
 * A pure function, and it exists because the obvious version is quietly broken. "Take the first N
 * accounts" refreshes the *same* N every hour and never reaches the rest — the sweep looks healthy,
 * the tally looks full, and account N+1's catalog is however old it was on the day it was added.
 * Ordering by staleness is what makes the batch a rate limit rather than a horizon.
 *
 * **An Account with no catalog sorts first.** Never-refreshed is more urgent than
 * refreshed-a-while-ago: it is the account whose catalog is missing entirely, usually because it
 * was added since the last tick, and an operator who just connected a provider should see its
 * models on the next tick rather than after every older account has taken a turn.
 *
 * Non-refreshable accounts are filtered *before* the cap, not skipped inside the loop. They never
 * acquire a `refreshed_at`, so they would sort first forever and consume the whole batch every
 * tick — the exact starvation this ordering exists to prevent.
 */
export function selectForRefresh(
  accounts: readonly AccountRow[],
  ages: readonly AccountCatalogAge[],
  limit: number,
): readonly AccountRow[] {
  const refreshedAt = new Map(ages.map((age) => [age.accountId, age.refreshedAt.getTime()]))

  return accounts
    .filter(isRefreshable)
    .map((account) => ({ account, at: refreshedAt.get(account.id) ?? Number.NEGATIVE_INFINITY }))
    .sort((left, right) => left.at - right.at || left.account.id.localeCompare(right.account.id))
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.account)
}
