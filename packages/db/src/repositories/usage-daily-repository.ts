import { type AnyColumn, and, gte, lt, sql } from "drizzle-orm"
import type { Database } from "../client"
import { USAGE_OUTCOME_SUCCESS } from "../schema/enums"
import { usageDaily } from "../schema/usage-daily"
import { usageRecords } from "../schema/usage-records"
import type { UsageDimension, UsageTotals } from "./usage-read-repository"

/**
 * The daily rollup — writer and reader. Repositories own SQL; this file is the
 * only place that knows `usage_daily` is a table.
 *
 * Every aggregate the console shows for a *closed* day is read from here rather
 * than by scanning raw rows: `usage_records` expires on the retention window
 * while this table does not, so a lifetime total has to survive the purge of the
 * rows that earned it, and a 30-day chart must never touch raw data
 * (docs/idea/08-observability.md, "Why it stays fast"). Today's partial day is
 * the one slice still computed from raw rows.
 *
 * {@link UsageTotals} and {@link UsageDimension} are reused from
 * `usage-read-repository` deliberately, not copied: the read service answers one
 * window by joining closed days from here to today's partial day from there, and
 * that join only type-checks — and only means anything — while both sides report
 * the same nine measures under the same names.
 */
export interface UsageDailyRepository {
  /**
   * Recomputes every UTC day the `[from, to)` window touches, from raw rows, and
   * returns how many rollup rows were written.
   *
   * **Whole days, always — that is what makes it idempotent.** The window is
   * widened to UTC day boundaries and each day is aggregated in full, so the
   * conflict update *replaces* the row rather than adding to it. Rolling up only
   * the last hour and accumulating would double-count the moment a run repeated,
   * and there is no third option that survives both a retry and a restart. The
   * cost is rescanning the current day on every run, bounded by one day's volume.
   *
   * **Never call this for a day whose raw rows have been swept.** Recomputing a
   * day from raw rows that no longer exist would overwrite a correct lifetime
   * total with a smaller one. The retention window is always wider than the
   * rollup cadence, which keeps that safe — as a contract on the caller, not as
   * something this statement can check.
   *
   * Attempts that never reached an account (nothing in scope, auth refused) have
   * no place at this grain and are skipped; they stay visible in `usage_records`
   * for the retention window.
   */
  rollup(from: Date, to: Date): Promise<number>
  /** Totals over closed days. Metered and notional spend stay apart, never summed. */
  totals(window: UsageDayRange): Promise<UsageTotals>
  /** Totals grouped by one dimension, biggest first. */
  breakdown(window: UsageDayRange, dimension: UsageDimension): Promise<UsageDailyGroupRow[]>
}

/**
 * A half-open range of UTC days.
 *
 * Days rather than timestamps because that is the table's grain: a `Date`-based
 * window would invite a caller to ask for "the last six hours" and silently get
 * a whole day back.
 */
export interface UsageDayRange {
  /** Inclusive, `YYYY-MM-DD`. */
  readonly fromDay: string
  /** Exclusive, so adjacent ranges never double-count the boundary day. */
  readonly toDay: string
}

/** One row of a breakdown, keyed by whatever dimension was grouped on. */
export interface UsageDailyGroupRow extends UsageTotals {
  /** Null when the dimension does not apply — no pool in scope, or a since-deleted account. */
  readonly id: string | null
}

/** The UTC day a moment falls in, in the `YYYY-MM-DD` form the `day` column stores. */
export function toUtcDay(at: Date): string {
  return at.toISOString().slice(0, 10)
}

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * The nine measures plus the write stamp — the columns a re-run replaces. The
 * grain columns are the conflict key and are never in this list.
 */
const REPLACED_COLUMNS = [
  "requests",
  "attempts",
  "errors",
  "tokens_in",
  "tokens_out",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost_metered",
  "cost_notional",
  "updated_at",
] as const

const DIMENSION_COLUMNS = {
  apiKeyId: usageDaily.apiKeyId,
  accountId: usageDaily.accountId,
  poolId: usageDaily.poolId,
  model: usageDaily.model,
} as const

export function createUsageDailyRepository(db: Database): UsageDailyRepository {
  const inRange = (window: UsageDayRange) =>
    and(gte(usageDaily.day, window.fromDay), lt(usageDaily.day, window.toDay))

  // `float8`, not `::int`: this table never rolls off, so a lifetime sum is
  // unbounded and an int cast would eventually fail the query outright with
  // `integer out of range`. Every measure here is integer-valued and exact in a
  // double far past any total a router will ever accumulate.
  const total = (column: AnyColumn) => sql<number>`coalesce(sum(${column}), 0)::float8`

  const aggregates = {
    requests: total(usageDaily.requests),
    attempts: total(usageDaily.attempts),
    errors: total(usageDaily.errors),
    tokensIn: total(usageDaily.tokensIn),
    tokensOut: total(usageDaily.tokensOut),
    cacheReadTokens: total(usageDaily.cacheReadTokens),
    cacheWriteTokens: total(usageDaily.cacheWriteTokens),
    // Spend stays exact — text out of a numeric, never a float.
    costMetered: sql<string>`coalesce(sum(${usageDaily.costMetered}), 0)::text`,
    costNotional: sql<string>`coalesce(sum(${usageDaily.costNotional}), 0)::text`,
  }

  return {
    rollup: async (from, to) => {
      const rows = await db.execute<{ id: string }>(
        rollupStatement(startOfUtcDay(from), startOfNextUtcDay(to)),
      )
      return rows.length
    },

    totals: async (window) => {
      const [row] = await db.select(aggregates).from(usageDaily).where(inRange(window))
      return row ?? EMPTY_TOTALS
    },

    breakdown: async (window, dimension) => {
      const column = DIMENSION_COLUMNS[dimension]
      return db
        .select({ id: sql<string | null>`${column}::text`, ...aggregates })
        .from(usageDaily)
        .where(inRange(window))
        .groupBy(column)
        .orderBy(sql`sum(${usageDaily.attempts}) desc`)
    },
  }
}

/**
 * `insert ... select ... on conflict do update`, hand-written because the
 * conflict target is an *expression* index — `coalesce(pool_id, sentinel)`, so
 * that two "no pool" rows collide instead of both inserting — and drizzle's
 * `onConflictDoUpdate` takes columns only.
 *
 * Qualified `"usage_records"."x"` references are reads from the source table;
 * the bare quoted names are the insert target's own columns, which Postgres
 * requires unqualified in the column list, the conflict target, and the SET.
 *
 * The two bounds cross as ISO strings with an explicit `::timestamptz`, not as
 * `Date`s: a value interpolated into a raw `sql` template carries no column, so
 * drizzle has no encoder to apply and hands the driver the object untouched —
 * which postgres.js then fails to serialize at bind time.
 */
function rollupStatement(scanFrom: Date, scanTo: Date) {
  const replaced = sql.raw(
    REPLACED_COLUMNS.map((column) => `"${column}" = excluded."${column}"`).join(", "),
  )

  return sql`
    insert into ${usageDaily} (
      "day", "api_key_id", "account_id", "pool_id", "model",
      "requests", "attempts", "errors",
      "tokens_in", "tokens_out", "cache_read_tokens", "cache_write_tokens",
      "cost_metered", "cost_notional", "updated_at"
    )
    select
      (${usageRecords.createdAt} at time zone 'UTC')::date,
      ${usageRecords.apiKeyId},
      ${usageRecords.accountId},
      ${usageRecords.poolId},
      ${usageRecords.model},
      count(distinct ${usageRecords.correlationId})::int,
      count(*)::int,
      count(*) filter (where ${usageRecords.outcome} <> ${USAGE_OUTCOME_SUCCESS})::int,
      coalesce(sum(${usageRecords.tokensIn}), 0),
      coalesce(sum(${usageRecords.tokensOut}), 0),
      coalesce(sum(${usageRecords.cacheReadTokens}), 0),
      coalesce(sum(${usageRecords.cacheWriteTokens}), 0),
      coalesce(sum(${usageRecords.costEstimate}) filter (where ${usageRecords.costBasis} = 'metered'), 0),
      coalesce(sum(${usageRecords.costEstimate}) filter (where ${usageRecords.costBasis} = 'notional'), 0),
      now()
    from ${usageRecords}
    where ${usageRecords.createdAt} >= ${scanFrom.toISOString()}::timestamptz
      and ${usageRecords.createdAt} < ${scanTo.toISOString()}::timestamptz
      and ${usageRecords.apiKeyId} is not null
      and ${usageRecords.accountId} is not null
    group by 1, 2, 3, 4, 5
    on conflict (
      "day", "api_key_id", "account_id",
      coalesce("pool_id", '00000000-0000-0000-0000-000000000000'::uuid), "model"
    )
    do update set ${replaced}
    returning "id"
  `
}

/**
 * Midnight UTC of the day `at` falls in.
 *
 * Exported alongside {@link toUtcDay} rather than kept private: the rollup task
 * and the usage read service both have to reason in this table's grain — one to
 * decide which days to recompute, the other to decide which days are closed —
 * and three private copies of the same boundary arithmetic is how two of them
 * eventually disagree about where a day starts.
 */
export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
}

/** The exclusive upper bound of the day `at` falls in — `at` itself when it is already midnight. */
export function startOfNextUtcDay(at: Date): Date {
  const start = startOfUtcDay(at)
  return start.getTime() === at.getTime() ? start : new Date(start.getTime() + MILLIS_PER_DAY)
}

const EMPTY_TOTALS: UsageTotals = {
  requests: 0,
  attempts: 0,
  errors: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMetered: "0",
  costNotional: "0",
}
