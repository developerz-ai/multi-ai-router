import { type AnyColumn, and, countDistinct, gte, lt, sql } from "drizzle-orm"
import type { Database } from "../client"
import { USAGE_OUTCOME_SUCCESS } from "../schema/enums"
import { usageRecords } from "../schema/usage-records"

import { attributedRaw, isAttributionDimension } from "./usage-attribution"
import { filterConditions } from "./usage-filter"
import type {
  UsageDimension,
  UsageFilter,
  UsageKeyAttribution,
  UsageRawTotals,
  UsageReadRepository,
  UsageWindow,
} from "./usage-read-types"
import { createTokensSince } from "./usage-tokens-since"

export * from "./usage-read-types"

const DIMENSION_COLUMNS = {
  apiKeyId: usageRecords.apiKeyId,
  accountId: usageRecords.accountId,
  poolId: usageRecords.poolId,
  model: usageRecords.model,
} as const

/**
 * Failed attempts, as one shared fragment: the totals/breakdown aggregates, the series, and the
 * daily rollup (`usage-daily-repository.ts`) all count "not success", and one spelling keeps the
 * three from drifting apart. `outcome` is a plain text column — its values are typed in
 * TypeScript, not as a Postgres enum — so the constant crosses as an ordinary string parameter;
 * the `::text` cast follows the raw-fragment convention (`usage-daily-repository.ts` documents
 * it), where no column encoder applies and the parameter's type is otherwise left to inference.
 */
export function errorAttempts() {
  return sql<number>`count(*) filter (where ${usageRecords.outcome} <> ${USAGE_OUTCOME_SUCCESS}::text)::float8`
}

/** A window's token total. `float8` for the reason given beside `aggregates` below. */
function tokenSum(column: AnyColumn) {
  return sql<number>`coalesce(sum(${column}), 0)::float8`
}

export function createUsageReadRepository(db: Database): UsageReadRepository {
  // The filter is applied inside the `created_at` range and nowhere else: the raw key and account
  // indexes were dropped (migration 0015), so a filter-only scan would read the whole table. Raw
  // panes therefore filter the same window the history facts do, and totals and outcomes agree.
  const inWindow = (window: UsageWindow, filter: UsageFilter) =>
    and(
      gte(usageRecords.createdAt, window.from),
      lt(usageRecords.createdAt, window.to),
      ...filterConditions(filter, {
        apiKeyId: sql`${usageRecords.apiKeyId}`,
        accountId: sql`${usageRecords.accountId}`,
        poolId: sql`${usageRecords.poolId}`,
        model: sql`${usageRecords.model}`,
      }),
    )

  // `count(distinct correlation_id)` for requests, `count(*)` for attempts — see the note above.
  //
  // Token sums are `float8`, never `::int`: a busy week of cache reads crosses 2^31 (production
  // measured 4.7 billion `cache_read_tokens` over seven days), and an int cast fails the whole
  // query with `integer out of range` — the usage page answered `500` for exactly that. A double
  // is exact for every integer a router will ever sum (2^53), and postgres.js hands it back as a
  // number, which is why the daily table (`usage-daily-repository.ts`) already chose it.
  const aggregates = {
    requests: countDistinct(usageRecords.correlationId),
    attempts: sql<number>`count(*)::float8`,
    errors: errorAttempts(),
    tokensIn: tokenSum(usageRecords.tokensIn),
    tokensOut: tokenSum(usageRecords.tokensOut),
    cacheReadTokens: tokenSum(usageRecords.cacheReadTokens),
    cacheWriteTokens: tokenSum(usageRecords.cacheWriteTokens),
    costMetered: sql<string>`coalesce(sum(${usageRecords.costEstimate}) filter (where ${usageRecords.costBasis} = 'metered'), 0)::text`,
    costNotional: sql<string>`coalesce(sum(${usageRecords.costEstimate}) filter (where ${usageRecords.costBasis} = 'notional'), 0)::text`,
  }

  // `bucket` is a value in a raw fragment, so no column encoder types it — `::text` names the
  // `date_trunc(text, timestamptz)` overload explicitly rather than leaning on inference from the
  // second argument (the raw-fragment convention `usage-daily-repository.ts` documents).
  const bucketExpr = (bucket: "hour" | "day") =>
    sql<string>`to_char(date_trunc(${bucket}::text, ${usageRecords.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

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

  // What a grouped read selects from and groups on. Owner and tool group on a bucket computed in a
  // subselect (`usage-attribution.ts`); the rest group on their column. Either way the window and
  // filter are applied exactly once.
  const target = (
    window: UsageWindow,
    dimension: UsageDimension,
    filter: UsageFilter,
    attribution: UsageKeyAttribution | undefined,
  ) =>
    isAttributionDimension(dimension)
      ? { ...attributedRaw(inWindow(window, filter), dimension, attribution), where: undefined }
      : {
          from: usageRecords,
          group: sql`${DIMENSION_COLUMNS[dimension]}`,
          where: inWindow(window, filter),
        }

  return {
    tokensSince: createTokensSince(db),

    totals: async (window, filter) => {
      const [row] = await db.select(aggregates).from(usageRecords).where(inWindow(window, filter))
      return row === undefined ? EMPTY_TOTALS : row
    },

    breakdown: async (window, dimension, ids, requestedLimit, filter, attribution) => {
      const limit = requestedLimit ?? 1000
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1001 || (ids?.length ?? 0) > 1000)
        throw new Error("usage breakdown outside bounds")
      const { from, group, where } = target(window, dimension, filter, attribution)
      const rows = await db
        .select({
          id: sql<string | null>`${group}::text`,
          ...aggregates,
          ...latencyAggregates,
        })
        .from(from)
        .where(
          and(
            where,
            ids === undefined
              ? undefined
              : ids.length === 0
                ? sql`false`
                : sql`(${sql.join(
                    ids.map((id) => sql`${group}::text is not distinct from ${id}`),
                    sql` or `,
                  )})`,
          ),
        )
        .groupBy(group)
        .orderBy(sql`count(*) desc`)
        .limit(limit)
      return rows
    },

    outcomes: async (window, filter) =>
      db
        .select({ outcome: usageRecords.outcome, attempts: sql<number>`count(*)::float8` })
        .from(usageRecords)
        .where(inWindow(window, filter))
        .groupBy(usageRecords.outcome),

    series: async (window, bucket, filter) =>
      db
        .select({
          at: bucketExpr(bucket),
          requests: countDistinct(usageRecords.correlationId),
          attempts: sql<number>`count(*)::float8`,
          errors: errorAttempts(),
        })
        .from(usageRecords)
        .where(inWindow(window, filter))
        .groupBy(sql`1`)
        .orderBy(sql`1`),

    seriesByDimension: async (window, bucket, dimension, filter, attribution) => {
      const { from, group, where } = target(window, dimension, filter, attribution)
      return (
        db
          .select({
            id: sql<string | null>`${group}::text`,
            at: bucketExpr(bucket),
            requests: countDistinct(usageRecords.correlationId),
          })
          .from(from)
          .where(where)
          // By ordinal, not by repeating the expression: a second `bucketExpr(bucket)` binds its own
          // parameter placeholder, so Postgres sees `date_trunc($1, …)` and `date_trunc($4, …)` as
          // two different expressions and rejects the select as not grouped.
          .groupBy(sql`1, 2`)
      )
    },

    latency: async (window, filter) => {
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
        .where(inWindow(window, filter))
      return row ?? { p50Ms: null, p95Ms: null, routerOverheadP95Ms: null, ttfbP95Ms: null }
    },
  }
}

const EMPTY_TOTALS: UsageRawTotals = {
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
