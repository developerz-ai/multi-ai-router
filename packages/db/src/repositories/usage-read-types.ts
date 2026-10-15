import type { UsageOutcome } from "../schema/enums"
import type { TokenSpanShape, TokenSpanUsage } from "./usage-token-spans"

export * from "./usage-token-spans"
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

/**
 * Which facts a usage read counts. A dimension that is `undefined` is not filtered; a dimension
 * that is an **empty array** matches nothing, so the read yields zeros produced by the query
 * itself. Dimensions combine with AND, the ids within one with OR.
 *
 * `apiKeyIds` is already resolved: owner and tool become key ids in the service layer, so the
 * repositories know nothing of labels. A `null` pool, account or key never matches an id list.
 */
export interface UsageFilter {
  readonly apiKeyIds?: readonly string[]
  readonly accountIds?: readonly string[]
  readonly poolIds?: readonly string[]
  readonly models?: readonly string[]
}

/** Totals from raw rows. Carries no unpriced measure: the history repository serves that. */
export interface UsageRawTotals {
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

export interface UsageTotals extends UsageRawTotals {
  /** Traffic the price table cannot see, so it never reads as free. */
  readonly unpriced: UsageUnpriced
}

export interface UsageUnpriced {
  /**
   * Unknown-basis attempts that used tokens, counted only on days on or after `since`. Null when
   * the window predates the measure entirely — not measured, never a zero that would read as
   * "nothing unpriced happened".
   */
  readonly attempts: number | null
  /**
   * First fully measured day, `YYYY-MM-DD` UTC. The literal `infinity` when the history state
   * never recorded one (never migrated): no day then counts as measured.
   */
  readonly since: string
}

/** The flat pair the measure queries return, before it is nested onto a totals row. */
export interface UnpricedRow {
  readonly unpricedAttempts: number | null
  readonly unpricedSince: string
}

/** Nests the flat query pair into the `unpriced` field every totals shape carries. */
export function nestUnpriced<T extends UnpricedRow>(
  row: T,
): Omit<T, "unpricedAttempts" | "unpricedSince"> & Pick<UsageTotals, "unpriced"> {
  const { unpricedAttempts, unpricedSince, ...rest } = row
  return { ...rest, unpriced: { attempts: unpricedAttempts, since: unpricedSince } }
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

/** Per-group latency, shared by the raw and the history-served breakdown rows. */
interface UsageGroupLatency {
  /** Null when the dimension does not apply — no pool in scope, or an account since deleted. */
  readonly id: string | null
  /** Percentiles for this group alone. "Which account is slow" is not answerable from a global p95. */
  readonly latencyP50Ms: number | null
  readonly latencyP95Ms: number | null
  readonly routerOverheadP95Ms: number | null
}

/** One row of a raw breakdown (latency source); no unpriced measure. */
export interface UsageRawGroupRow extends UsageRawTotals, UsageGroupLatency {}

/** One row of a breakdown, keyed by whatever dimension was grouped on. */
export interface UsageGroupRow extends UsageTotals, UsageGroupLatency {}

export type UsageDimension = "apiKeyId" | "accountId" | "poolId" | "model"

export interface UsageReadRepository {
  totals(window: UsageWindow, filter: UsageFilter): Promise<UsageRawTotals>
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
  breakdown(
    window: UsageWindow,
    dimension: UsageDimension,
    ids: readonly (string | null)[] | undefined,
    limit: number | undefined,
    filter: UsageFilter,
  ): Promise<UsageRawGroupRow[]>
  /**
   * Attempts per outcome over the window — the split behind "3% failed, of which what?".
   *
   * Unordered on purpose. It is at most one row per member of `UsageOutcome`, and which of them
   * an operator should read first is a display decision that belongs in a pure function a test can
   * reach without a database (`usage-read/failures.ts`), not in an `ORDER BY` nobody can assert.
   */
  outcomes(window: UsageWindow, filter: UsageFilter): Promise<UsageOutcomeCount[]>
  /** Request counts per time bucket, for the sparkline. Gaps are absent, not zero-filled. */
  series(
    window: UsageWindow,
    bucket: "hour" | "day",
    filter: UsageFilter,
  ): Promise<UsageSeriesPoint[]>
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
    filter: UsageFilter,
  ): Promise<UsageGroupSeriesPoint[]>
  /**
   * p50/p95 latency and router overhead over the window. Null when nothing was recorded.
   *
   * Cast to `int` explicitly: `percentile_disc` is exact-valued, and without the cast the driver
   * can hand back a numeric as a string.
   */
  latency(window: UsageWindow, filter: UsageFilter): Promise<UsageLatency>
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
