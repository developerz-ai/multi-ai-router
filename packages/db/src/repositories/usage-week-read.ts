import { sql } from "drizzle-orm"
import type { Database } from "../client"
import { unpricedSinceSql } from "./usage-history-shared"
import { historySource } from "./usage-history-source"
import type { UsageWindow } from "./usage-read-types"

/**
 * One row of the weekly report's input: a whole UTC week at key x account x pool x model, with no
 * day dimension. Every dimension is nullable because every one can be absent (a null key, an
 * attempt that never reached an account or a pool, a request with no model). Money is
 * `numeric(24,6)` text so the report sums it exactly; the counts are float8 like the totals they
 * must add up to.
 */
export interface UsageWeekRow {
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
   * Null only when the whole week predates the unpriced measure (`unpricedSince` is after its last
   * day): not measured, never a zero that would read as "nothing was unpriced". Otherwise a group
   * with nothing unpriced reads 0, including a request-only group, because the rollup projects
   * `null` for its request rows and a plain `sum` would turn them into a null.
   */
  readonly unpricedAttempts: number | null
  /**
   * Attempts on days on or after `unpricedSince`: the denominator of the unpriced share. In a week
   * that straddles the start of the measure, `attempts` includes unmeasured days and dividing the
   * measured numerator by it would understate the share.
   */
  readonly measuredAttempts: number
}

/**
 * The week has more key x account x pool x model rows than the ceiling. Thrown, never absorbed
 * into a truncated report: a report that silently dropped rows would still add up to itself.
 */
export class UsageWeekRowCeilingError extends Error {
  constructor(readonly ceiling: number) {
    super(`usage week read exceeds its ceiling of ${ceiling} rows`)
    this.name = "UsageWeekRowCeilingError"
  }
}

export interface UsageWeekRead {
  /** First fully measured day of the unpriced measure, `YYYY-MM-DD` UTC, or `infinity`. */
  readonly unpricedSince: string
  readonly rows: UsageWeekRow[]
}

const DAY_MS = 86_400_000

/**
 * The week behind the weekly report, over the same three-source union the summary and the CSV
 * export read (`historySource`, without the hourly flag), so the report's figures are the
 * summary's for the same window. Its own file: `usage-read-repository.ts` is at the file cap and
 * this query shares nothing with it but the source.
 *
 * The window must be whole UTC days. A fractional window would pull the contributions edge branch
 * of the source in, and the report is dated by day.
 */
export async function readUsageWeekRows(
  db: Database,
  window: UsageWindow,
  ceiling: number,
): Promise<UsageWeekRead> {
  if (!Number.isSafeInteger(ceiling) || ceiling < 1)
    throw new Error("usage week ceiling outside bounds")
  const from = window.from.getTime()
  const to = window.to.getTime()
  if (from % DAY_MS !== 0 || to % DAY_MS !== 0 || to <= from)
    throw new Error("usage week read needs a window of whole UTC days")
  const since = unpricedSinceSql()
  const lastDay = new Date(to - DAY_MS).toISOString().slice(0, 10)
  const result = await db.execute(sql`
    with facts as (${historySource(window, false, {})})
    select api_key_id as "apiKeyId", account_id as "accountId", pool_id as "poolId", model,
      coalesce(sum(requests),0)::float8 as requests, coalesce(sum(attempts),0)::float8 as attempts,
      coalesce(sum(errors),0)::float8 as errors, coalesce(sum(tokens_in),0)::float8 as "tokensIn",
      coalesce(sum(tokens_out),0)::float8 as "tokensOut",
      coalesce(sum(cache_read_tokens),0)::float8 as "cacheReadTokens",
      coalesce(sum(cache_write_tokens),0)::float8 as "cacheWriteTokens",
      round(coalesce(sum(cost_metered),0), 6)::text as "costMetered",
      round(coalesce(sum(cost_notional),0), 6)::text as "costNotional",
      (case when ${since} > ${lastDay}::date then null::float8 else coalesce(sum(unpriced_attempts),0)::float8 end) as "unpricedAttempts",
      coalesce(sum(attempts) filter (where (event_at at time zone 'UTC')::date >= ${since}),0)::float8 as "measuredAttempts",
      ${since}::text as "unpricedSince"
    from facts
    group by api_key_id, account_id, pool_id, model
    order by api_key_id nulls last, account_id nulls last, pool_id nulls last, model nulls last
    limit ${ceiling + 1}`)
  if ([...result].length > ceiling) throw new UsageWeekRowCeilingError(ceiling)
  const raw = [...result] as unknown as (UsageWeekRow & { unpricedSince: string })[]
  if (raw.length === 0) {
    // An empty week still reports the measure's start, so the report can say "not measured".
    const [row] = [
      ...(await db.execute(sql`select ${since}::text as "unpricedSince"`)),
    ] as unknown as {
      unpricedSince: string
    }[]
    return { unpricedSince: row?.unpricedSince ?? "infinity", rows: [] }
  }
  return {
    unpricedSince: raw[0]?.unpricedSince ?? "infinity",
    rows: raw.map(({ unpricedSince: _since, ...row }) => row),
  }
}
