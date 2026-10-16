import type { UsageHistoryRepository } from "@multi-ai-router/db"
import { type ResolvedWindow, resolveWindow, type UsageWindowQuery } from "./window"

/**
 * The window a usage read covers, resolved against the database clock inside the caller's
 * snapshot. The summary and the CSV export both call this, so a given query names the same
 * instants in both: "lifetime" starts at the earliest retained fact rather than the epoch.
 */
export async function resolveReadWindow(
  history: Pick<UsageHistoryRepository, "clock">,
  query: UsageWindowQuery,
): Promise<ResolvedWindow> {
  // Only the clock and the earliest retained instant matter here. Calling `coverage()` with no
  // window used to run its `pending`/`legacy` anti-joins over every retained row — ~half the cost
  // of a large summary — for two fields. See docs/idea/08-observability.md.
  const initial = await history.clock()
  const requested = resolveWindow(query, initial.dbNow)
  return requested.label === "lifetime"
    ? {
        ...requested,
        from:
          initial.earliestAt !== null && initial.earliestAt < requested.to
            ? initial.earliestAt
            : requested.to,
      }
    : requested
}
