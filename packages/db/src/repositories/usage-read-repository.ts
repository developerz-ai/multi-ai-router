import { and, countDistinct, gte, lt, sql } from "drizzle-orm"
import type { Database } from "../client"
import { USAGE_OUTCOME_SUCCESS } from "../schema/enums"
import { usageRecords } from "../schema/usage-records"

/**
 * Reads over `usage_records` for the console's usage surface.
 *
 * Separate from `usage-repository.ts` on purpose: that one is the batch writer the request path
 * feeds, this one is the aggregate reader an admin screen calls. They share a table and nothing
 * else — different callers, different shapes, different reasons to change.
 *
 * **Every query here counts requests and attempts separately.** A row is one upstream *attempt*,
 * so a failover chain of three writes three rows under one `correlationId`. Summing rows to get
 * "requests" would report a bad afternoon as a busy one, which is exactly backwards. Requests are
 * `count(distinct correlation_id)`; attempts are `count(*)`.
 *
 * Cost is likewise two columns that are never added together: a subscription account has no
 * per-token price, only an attribution, so metered and notional spend answer different questions
 * and a single "cost" would be a number with no meaning.
 */

export interface UsageWindow {
  readonly from: Date
  /** Exclusive, so adjacent windows never double-count the boundary row. */
  readonly to: Date
}

export interface UsageTotals {
  readonly requests: number
  readonly attempts: number
  readonly errors: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** Spend on accounts that meter per token. Never summed with `costNotional`. */
  readonly costMetered: string
  /** What the same traffic would have cost at list price on a subscription account. */
  readonly costNotional: string
}

/** One row of a breakdown, keyed by whatever dimension was grouped on. */
export interface UsageGroupRow extends UsageTotals {
  /** Null when the dimension does not apply — no pool in scope, or an account since deleted. */
  readonly id: string | null
  /** Percentiles for this group alone. "Which account is slow" is not answerable from a global p95. */
  readonly latencyP50Ms: number | null
  readonly latencyP95Ms: number | null
  readonly routerOverheadP95Ms: number | null
}

export type UsageDimension = "apiKeyId" | "accountId" | "poolId" | "model"

export interface UsageReadRepository {
  totals(window: UsageWindow): Promise<UsageTotals>
  /** Totals grouped by one dimension, biggest first. */
  breakdown(window: UsageWindow, dimension: UsageDimension): Promise<UsageGroupRow[]>
  /** Request counts per time bucket, for the sparkline. Gaps are absent, not zero-filled. */
  series(window: UsageWindow, bucket: "hour" | "day"): Promise<UsageSeriesPoint[]>
  /**
   * Request counts per (group, bucket), for the inline sparkline on every breakdown row.
   *
   * One query for every row's series rather than one per row: a breakdown of fifty accounts must
   * not become fifty queries because the table grew.
   */
  seriesByDimension(
    window: UsageWindow,
    bucket: "hour" | "day",
    dimension: UsageDimension,
  ): Promise<UsageGroupSeriesPoint[]>
  /**
   * p50/p95 latency and router overhead over the window. Null when nothing was recorded.
   *
   * Cast to `int` explicitly: `percentile_disc` is exact-valued, and without the cast the driver
   * can hand back a numeric as a string.
   */
  latency(window: UsageWindow): Promise<UsageLatency>
}

export interface UsageSeriesPoint {
  /**
   * Bucket start, as an ISO-8601 UTC string.
   *
   * Formatted **in Postgres** rather than returned as a timestamp and converted here. A raw `sql`
   * fragment carries no type information, so the driver hands back whatever it parses and a
   * `sql<Date>` annotation would be an assertion nobody checked — which is exactly how this
   * returned a string that every caller treated as a `Date`.
   */
  readonly at: string
  readonly requests: number
  readonly attempts: number
  readonly errors: number
}

export interface UsageGroupSeriesPoint {
  readonly id: string | null
  readonly at: string
  readonly requests: number
}

export interface UsageLatency {
  readonly p50Ms: number | null
  readonly p95Ms: number | null
  readonly routerOverheadP95Ms: number | null
  readonly ttfbP95Ms: number | null
}

const DIMENSION_COLUMNS = {
  apiKeyId: usageRecords.apiKeyId,
  accountId: usageRecords.accountId,
  poolId: usageRecords.poolId,
  model: usageRecords.model,
} as const

export function createUsageReadRepository(db: Database): UsageReadRepository {
  const inWindow = (window: UsageWindow) =>
    and(gte(usageRecords.createdAt, window.from), lt(usageRecords.createdAt, window.to))

  // `count(distinct correlation_id)` for requests, `count(*)` for attempts — see the note above.
  const aggregates = {
    requests: countDistinct(usageRecords.correlationId),
    attempts: sql<number>`count(*)::int`,
    errors: sql<number>`count(*) filter (where ${usageRecords.outcome} <> ${USAGE_OUTCOME_SUCCESS})::int`,
    tokensIn: sql<number>`coalesce(sum(${usageRecords.tokensIn}), 0)::int`,
    tokensOut: sql<number>`coalesce(sum(${usageRecords.tokensOut}), 0)::int`,
    cacheReadTokens: sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)::int`,
    cacheWriteTokens: sql<number>`coalesce(sum(${usageRecords.cacheWriteTokens}), 0)::int`,
    costMetered: sql<string>`coalesce(sum(${usageRecords.costEstimate}) filter (where ${usageRecords.costBasis} = 'metered'), 0)::text`,
    costNotional: sql<string>`coalesce(sum(${usageRecords.costEstimate}) filter (where ${usageRecords.costBasis} = 'notional'), 0)::text`,
  }

  const bucketExpr = (bucket: "hour" | "day") =>
    sql<string>`to_char(date_trunc(${bucket}, ${usageRecords.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

  const latencyAggregates = {
    latencyP50Ms: sql<
      number | null
    >`(percentile_disc(0.5) within group (order by ${usageRecords.latencyMs}))::int`,
    latencyP95Ms: sql<
      number | null
    >`(percentile_disc(0.95) within group (order by ${usageRecords.latencyMs}))::int`,
    routerOverheadP95Ms: sql<
      number | null
    >`(percentile_disc(0.95) within group (order by ${usageRecords.routerOverheadMs}))::int`,
  }

  return {
    totals: async (window) => {
      const [row] = await db.select(aggregates).from(usageRecords).where(inWindow(window))
      return row ?? EMPTY_TOTALS
    },

    breakdown: async (window, dimension) => {
      const column = DIMENSION_COLUMNS[dimension]
      return db
        .select({ id: sql<string | null>`${column}::text`, ...aggregates, ...latencyAggregates })
        .from(usageRecords)
        .where(inWindow(window))
        .groupBy(column)
        .orderBy(sql`count(*) desc`)
    },

    series: async (window, bucket) =>
      db
        .select({
          at: bucketExpr(bucket),
          requests: countDistinct(usageRecords.correlationId),
          attempts: sql<number>`count(*)::int`,
          errors: sql<number>`count(*) filter (where ${usageRecords.outcome} <> ${USAGE_OUTCOME_SUCCESS})::int`,
        })
        .from(usageRecords)
        .where(inWindow(window))
        .groupBy(sql`1`)
        .orderBy(sql`1`),

    seriesByDimension: async (window, bucket, dimension) => {
      const column = DIMENSION_COLUMNS[dimension]
      return (
        db
          .select({
            id: sql<string | null>`${column}::text`,
            at: bucketExpr(bucket),
            requests: countDistinct(usageRecords.correlationId),
          })
          .from(usageRecords)
          .where(inWindow(window))
          // By ordinal, not by repeating the expression: a second `bucketExpr(bucket)` binds its own
          // parameter placeholder, so Postgres sees `date_trunc($1, …)` and `date_trunc($4, …)` as
          // two different expressions and rejects the select as not grouped.
          .groupBy(sql`1, 2`)
      )
    },

    latency: async (window) => {
      const [row] = await db
        .select({
          // `percentile_disc` returns a value that actually occurred, rather than interpolating
          // between two attempts into a latency nothing experienced.
          p50Ms: sql<
            number | null
          >`(percentile_disc(0.5) within group (order by ${usageRecords.latencyMs}))::int`,
          p95Ms: sql<
            number | null
          >`(percentile_disc(0.95) within group (order by ${usageRecords.latencyMs}))::int`,
          routerOverheadP95Ms: sql<
            number | null
          >`(percentile_disc(0.95) within group (order by ${usageRecords.routerOverheadMs}))::int`,
          // NULL ttfb rows are excluded rather than counted as zero: an attempt that relayed no
          // byte has no time-to-first-byte, and folding it in as 0 would flatter the metric that
          // exists to catch a buffering regression.
          ttfbP95Ms: sql<
            number | null
          >`(percentile_disc(0.95) within group (order by ${usageRecords.ttfbMs}) filter (where ${usageRecords.ttfbMs} is not null))::int`,
        })
        .from(usageRecords)
        .where(inWindow(window))
      return row ?? { p50Ms: null, p95Ms: null, routerOverheadP95Ms: null, ttfbP95Ms: null }
    },
  }
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
