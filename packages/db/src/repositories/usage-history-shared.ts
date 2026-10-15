import { sql } from "drizzle-orm"
import { usageHistoryState } from "../schema/usage-history-state"

/** Receipt payload keys of the nine summed measures, in the order of their aggregate columns. */
export const payloadMeasures = [
  "requests",
  "attempts",
  "errors",
  "tokensIn",
  "tokensOut",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costMetered",
  "costNotional",
] as const

/**
 * The first fully measured day of the unpriced measure, as a SQL date expression. `infinity` when
 * the state has no `unpriced_since` (never migrated): every day then reads as before measurement,
 * so the measure reports null rather than inventing coverage.
 */
export const unpricedSinceSql = () =>
  sql`coalesce((select unpriced_since from ${usageHistoryState} where id = 'v2'), 'infinity'::date)`
