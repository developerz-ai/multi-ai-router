import { type AnyColumn, and, countDistinct, gte, lt, sql } from "drizzle-orm"
import type { Database } from "../client"
import { USAGE_OUTCOME_SUCCESS } from "../schema/enums"
import { usageRecords } from "../schema/usage-records"

import {
  foldTokenSpans,
  type UsageReadRepository,
  type UsageTotals,
  type UsageWindow,
} from "./usage-read-types"

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
  /**
   * One statement over a VALUES list of (account, window, since), so a fleet of subscriptions
   * costs one round trip rather than one per window per account.
   */
  const tokensSince: UsageReadRepository["tokensSince"] = async (spans, shape) => {
    if (spans.length === 0) return []

    // `width_bucket` refuses a range whose bounds are equal, and a span that has not opened yet has
    // nothing to measure anyway. Dropped rather than clamped: a zero-width window is a caller bug,
    // and silently widening it would report tokens against a range nobody asked about.
    const usable =
      shape === undefined
        ? spans
        : spans.filter((span) => span.since.getTime() < shape.until.getTime())
    if (usable.length === 0) return []

    const values = sql.join(
      usable.map(
        (span) =>
          sql`(${span.accountId}::uuid, ${span.window}::text, ${span.since.toISOString()}::timestamptz)`,
      ),
      sql`, `,
    )

    const tokenSum = sql`coalesce(sum(
      ${usageRecords.tokensIn} + ${usageRecords.tokensOut}
      + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens}
    ), 0)`

    // Equal divisions of each span's own `since..until`, so every window yields the same number of
    // points whatever its length. `width_bucket` answers 1..slots inside the range; the join's own
    // bounds keep anything outside it out, and a `null` here is the left join's empty side.
    //
    // `width_bucket` refuses a non-positive bucket count as hard as it refuses equal bounds, and
    // `slots` crosses as a bare parameter no column encoder types (hence the `::int`). A shape with
    // no positive width keeps its bounds — they still name each span's measured range — but draws
    // no curve, the same answer `foldTokenSpans` gives an empty width: a caller bug degrades to
    // "no sparkline", never a server error on the whole statement.
    const bucketed = shape !== undefined && shape.slots > 0
    const slot = bucketed
      ? sql`width_bucket(
          extract(epoch from ${usageRecords.createdAt}),
          extract(epoch from s.since),
          extract(epoch from ${shape.until.toISOString()}::timestamptz),
          ${shape.slots}::int
        )`
      : sql`null::int`

    const upperBound =
      shape === undefined
        ? sql``
        : sql`and ${usageRecords.createdAt} < ${shape.until.toISOString()}::timestamptz`

    // `window_kind`, never `window`: WINDOW is a reserved keyword in Postgres (it introduces a
    // window-function clause), so an alias column named `window` makes the whole statement a
    // syntax error. Renaming is clearer than quoting — nobody has to remember the quotes later.
    const rows = await db.execute<{
      account_id: string
      window_kind: string
      slot: number | null
      tokens: string | number
    }>(
      sql`
        select s.account_id, s.window_kind, ${slot} as slot, ${tokenSum} as tokens
        from (values ${values}) as s(account_id, window_kind, since)
        left join ${usageRecords}
          on ${usageRecords.accountId} = s.account_id
         and ${usageRecords.createdAt} >= s.since
         ${upperBound}
        group by s.account_id, s.window_kind, slot
      `,
    )

    return foldTokenSpans([...rows], bucketed ? shape.slots : 0)
  }

  const inWindow = (window: UsageWindow) =>
    and(gte(usageRecords.createdAt, window.from), lt(usageRecords.createdAt, window.to))

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

  return {
    tokensSince,

    totals: async (window) => {
      const [row] = await db.select(aggregates).from(usageRecords).where(inWindow(window))
      return row ?? EMPTY_TOTALS
    },

    breakdown: async (window, dimension, ids, limit = 1000) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1001 || (ids?.length ?? 0) > 1000)
        throw new Error("usage breakdown outside bounds")
      const column = DIMENSION_COLUMNS[dimension]
      return db
        .select({ id: sql<string | null>`${column}::text`, ...aggregates, ...latencyAggregates })
        .from(usageRecords)
        .where(
          and(
            inWindow(window),
            ids === undefined
              ? undefined
              : ids.length === 0
                ? sql`false`
                : sql`(${sql.join(
                    ids.map((id) => sql`${column}::text is not distinct from ${id}`),
                    sql` or `,
                  )})`,
          ),
        )
        .groupBy(column)
        .orderBy(sql`count(*) desc`)
        .limit(limit)
    },

    outcomes: async (window) =>
      db
        .select({ outcome: usageRecords.outcome, attempts: sql<number>`count(*)::float8` })
        .from(usageRecords)
        .where(inWindow(window))
        .groupBy(usageRecords.outcome),

    series: async (window, bucket) =>
      db
        .select({
          at: bucketExpr(bucket),
          requests: countDistinct(usageRecords.correlationId),
          attempts: sql<number>`count(*)::float8`,
          errors: errorAttempts(),
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
