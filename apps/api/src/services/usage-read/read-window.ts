import type { UsageHistoryRepository } from "@multi-ai-router/db"
import { type ResolvedWindow, resolveWindow, type UsageWindowQuery } from "./window"

/**
 * The window a usage read covers, resolved against the database clock inside the caller's
 * snapshot. The summary and the CSV export both call this, so a given query names the same
 * instants in both: "lifetime" starts at the earliest retained fact rather than the epoch.
 */
export async function resolveReadWindow(
  history: Pick<UsageHistoryRepository, "coverage">,
  query: UsageWindowQuery,
): Promise<ResolvedWindow> {
  const initial = await history.coverage()
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
