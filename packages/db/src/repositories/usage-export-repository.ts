import { sql } from "drizzle-orm"
import type { Database } from "../client"
import { unpricedSinceSql } from "./usage-history-shared"
import { historySource } from "./usage-history-source"
import type { UsageFilter, UsageWindow } from "./usage-read-types"

/**
 * One row of the CSV export: a UTC day by key by account by pool by model.
 *
 * Ids are nullable because every dimension is (a pool-less key, an attempt that never reached an
 * account). Costs are `numeric(24,6)` text so the file never rounds money through a float; the
 * counts are float8 like the totals they must add up to.
 */
export interface UsageExportRow {
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string
  readonly apiKeyId: string | null
  readonly accountId: string | null
  readonly poolId: string | null
  readonly model: string | null
  readonly requests: number
  readonly attempts: number
  readonly errors: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costMetered: string
  readonly costNotional: string
  /**
   * Null on a day before the unpriced measure started: never a back-filled zero (#220). On a
   * measured day a group with only request-level facts reads 0, which is what `historySums` does.
   */
  readonly unpricedAttempts: number | null
}

/**
 * Reads at most `limit` export rows over the same three-source union the summary totals read
 * (`historySource`, without the hourly flag), under the same filter predicate. That shared source
 * is what makes the per-column sums of the file equal the summary for the same filters.
 *
 * Its own file: `usage-read-repository.ts` and its types are at the file cap, and this query shares
 * nothing with them but the source. The caller passes `cap + 1` as `limit` and treats a full page
 * as "over the cap" before it writes a byte.
 */
export async function readUsageExportRows(
  db: Database,
  window: UsageWindow,
  filter: UsageFilter | undefined,
  limit: number,
): Promise<UsageExportRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("usage export limit outside bounds")
  const since = unpricedSinceSql()
  const rows = await db.execute(sql`
    with facts as (${historySource(window, false, filter)}),
    days as (select (event_at at time zone 'UTC')::date as day, * from facts)
    select day::text as day, api_key_id as "apiKeyId", account_id as "accountId", pool_id as "poolId", model,
      coalesce(sum(requests),0)::float8 as requests, coalesce(sum(attempts),0)::float8 as attempts,
      coalesce(sum(errors),0)::float8 as errors, coalesce(sum(tokens_in),0)::float8 as "tokensIn",
      coalesce(sum(tokens_out),0)::float8 as "tokensOut", coalesce(sum(cache_read_tokens),0)::float8 as "cacheReadTokens",
      coalesce(sum(cache_write_tokens),0)::float8 as "cacheWriteTokens",
      round(coalesce(sum(cost_metered),0), 6)::text as "costMetered", round(coalesce(sum(cost_notional),0), 6)::text as "costNotional",
      (case when day < ${since} then null::float8 else coalesce(sum(unpriced_attempts),0)::float8 end) as "unpricedAttempts"
    from days
    group by day, api_key_id, account_id, pool_id, model
    order by day, api_key_id nulls last, account_id nulls last, pool_id nulls last, model nulls last
    limit ${limit}`)
  return [...rows] as unknown as UsageExportRow[]
}
