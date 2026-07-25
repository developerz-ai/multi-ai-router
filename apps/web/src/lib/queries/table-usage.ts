import { createMemo } from "solid-js"
import {
  type UsageDimension,
  type UsageSummary,
  type UsageWindow,
  usageWindowLabel,
} from "../api/usage"
import { indexUsage, type UsageRowSummary } from "../usage-index"
import { useUsageSummary } from "./usage"

/** The two dimensions that have a table of their own. Narrowed, so no caller can pass a third. */
export type TableUsageDimension = Extract<UsageDimension, "key" | "account">

/** What a table needs to render a usage column, in the four props the tables take. */
export interface TableUsage {
  readonly usage: ReadonlyMap<string, UsageRowSummary>
  readonly usageBucket: "hour" | "day"
  readonly usageLoading: boolean
  readonly usageWindowLabel: string
}

/**
 * The window the keys and accounts tables report over.
 *
 * Fixed, and deliberately not a per-table picker: those tables answer "which key is busy" and
 * "which account is carrying the load", and the usage screen is where a window is chosen. Two
 * window controls on two screens is how they come to disagree about what "this week" means.
 */
const TABLE_USAGE_WINDOW: UsageWindow = "7d"

/**
 * Usage for one dimension, ready to spread onto a table.
 *
 * Shared by the keys and accounts tables because the wiring was identical in both and the risk is
 * that it stops being: the same cache key means opening one table after the other — or after the
 * usage screen — is a cache hit rather than a second aggregate over the same `UsageRecord` rows.
 */
export function useTableUsage(dimension: TableUsageDimension): () => TableUsage {
  const summary = useUsageSummary(() => TABLE_USAGE_WINDOW)
  const index = createMemo(() => indexUsage(rowsFor(summary.data, dimension)))

  return () => ({
    usage: index(),
    usageBucket: summary.data?.bucket ?? "day",
    usageLoading: summary.isPending,
    usageWindowLabel: usageWindowLabel(TABLE_USAGE_WINDOW),
  })
}

/** A `switch` with no `default`: a third table dimension fails the build rather than silently
 * rendering the accounts breakdown under a keys table. */
function rowsFor(summary: UsageSummary | undefined, dimension: TableUsageDimension) {
  if (summary === undefined) return []
  switch (dimension) {
    case "key":
      return summary.byKey
    case "account":
      return summary.byAccount
  }
}
