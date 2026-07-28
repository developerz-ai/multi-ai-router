import { and, countDistinct, gte, lt, sql } from "drizzle-orm"
import type { Database } from "../client"
import { USAGE_OUTCOME_SUCCESS, type UsageOutcome } from "../schema/enums"
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

/**
 * How many attempts ended in one outcome.
 *
 * Read from raw rows only, and never from `usage_daily`: the rollup's grain is a key *and* an
 * account, so every attempt that never reached one — nothing in scope, a revoked key, a body over
 * the ceiling — is skipped there by construction. Those are exactly the failures an operator comes
 * to this surface to find, so widening the rollup would not fix it either. The consequence is
 * stated where it is read (`usage-read/failures.ts`), not hidden here.
 */
export interface UsageOutcomeCount {
  readonly outcome: UsageOutcome
  readonly attempts: number
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
  /**
   * Tokens this account consumed **inside one quota window's own span**, per (account, window).
   *
   * Every pair carries its own `since`, and that is the whole reason this is not a `window` query:
   * a five-hour window resetting in twenty minutes started 4h40m ago, so "the last five hours" and
   * "the five hours this window covers" are different ranges that diverge by however long ago the
   * window opened. One statement for the whole set — many accounts of one provider is the normal
   * case, and a query per row becomes a query storm the moment a fifth subscription is added.
   *
   * Counts every token the account was billed for — input, output, and both cache halves — because
   * that is what a provider's own allowance meters. Rows whose account was deleted are excluded by
   * the join, never counted as zero.
   */
  tokensSince(
    spans: readonly { readonly accountId: string; readonly window: string; readonly since: Date }[],
    shape?: TokenSpanShape,
  ): Promise<readonly TokenSpanUsage[]>
  /** Totals grouped by one dimension, biggest first. */
  breakdown(window: UsageWindow, dimension: UsageDimension): Promise<UsageGroupRow[]>
  /**
   * Attempts per outcome over the window — the split behind "3% failed, of which what?".
   *
   * Unordered on purpose. It is at most one row per member of `UsageOutcome`, and which of them
   * an operator should read first is a display decision that belongs in a pure function a test can
   * reach without a database (`usage-read/failures.ts`), not in an `ORDER BY` nobody can assert.
   */
  outcomes(window: UsageWindow): Promise<UsageOutcomeCount[]>
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

/**
 * Ask `tokensSince` for the *shape* of a window's consumption as well as its total.
 *
 * Optional because the total alone answers "how much of this window is gone", which is what the
 * progress bar needs. The shape answers the different question beside it — "how fast" — and a
 * window two-thirds spent in its first hour is a very different situation from one two-thirds spent
 * evenly, which a single number cannot distinguish.
 *
 * One query either way: the total is the sum of the buckets, so asking for both costs nothing over
 * asking for one. Slots are **equal divisions of `since..until`**, not clock hours, because each
 * window has its own span and a fixed bucket would give a five-hour window five points and a
 * seven-day one a hundred and sixty-eight.
 */
export interface TokenSpanShape {
  /** The end of every span. The same instant for all of them — "now", as the caller sees it. */
  readonly until: Date
  /** How many equal buckets to divide each span into. */
  readonly slots: number
}

export interface TokenSpanUsage {
  readonly accountId: string
  readonly window: string
  readonly tokens: number
  /**
   * Tokens per slot, oldest first, zero-filled. Empty when no shape was asked for.
   *
   * Zero-filled rather than sparse: a quiet hour inside a window is a real measurement and a
   * sparkline that closed the gap would draw a smooth line through a pause that actually happened.
   */
  readonly series: readonly number[]
}

/**
 * Slot rows back into one entry per (account, window): the zero-filled series, and the total as the
 * sum of it.
 *
 * The total is derived from the buckets rather than summed by a second aggregate, so the bar and
 * the sparkline beside it cannot disagree — they are literally the same numbers. A `null` slot is
 * the left join's empty side (an account that recorded nothing in its span) and contributes zero
 * without disturbing the series, which is what makes an idle account render as a flat line at zero
 * rather than dropping out of the answer.
 *
 * Exported for its own test: the SQL needs a database, this does not.
 */
export function foldTokenSpans(
  rows: readonly {
    readonly account_id: string
    readonly window_kind: string
    readonly slot: number | null
    readonly tokens: string | number
  }[],
  slots: number,
): readonly TokenSpanUsage[] {
  const width = Math.max(0, slots)
  const byPair = new Map<
    string,
    { accountId: string; window: string; series: number[]; unbucketed: number }
  >()

  for (const row of rows) {
    const key = `${row.account_id} ${row.window_kind}`
    const entry = byPair.get(key) ?? {
      accountId: row.account_id,
      window: row.window_kind,
      series: Array.from({ length: width }, () => 0),
      unbucketed: 0,
    }
    // `sum` is bigint-shaped, which the driver hands back as a string.
    const tokens = Number(row.tokens)
    // `width_bucket` numbers from 1; `null` is the empty side of the left join, and anything
    // outside 1..slots is a boundary the join's own bounds should already have excluded. Either
    // way those tokens still count toward the total — they are simply not placed on the curve.
    const index = (row.slot ?? 0) - 1
    if (index >= 0 && index < width) {
      entry.series[index] = (entry.series[index] ?? 0) + tokens
    } else {
      entry.unbucketed += tokens
    }
    byPair.set(key, entry)
  }

  return [...byPair.values()].map((entry) => ({
    accountId: entry.accountId,
    window: entry.window,
    tokens: entry.series.reduce((sum, value) => sum + value, entry.unbucketed),
    series: width > 0 ? entry.series : [],
  }))
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
    const slot =
      shape === undefined
        ? sql`null::int`
        : sql`width_bucket(
            extract(epoch from ${usageRecords.createdAt}),
            extract(epoch from s.since),
            extract(epoch from ${shape.until.toISOString()}::timestamptz),
            ${shape.slots}
          )`

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

    return foldTokenSpans([...rows], shape?.slots ?? 0)
  }

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
    tokensSince,

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

    outcomes: async (window) =>
      db
        .select({ outcome: usageRecords.outcome, attempts: sql<number>`count(*)::int` })
        .from(usageRecords)
        .where(inWindow(window))
        .groupBy(usageRecords.outcome),

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
