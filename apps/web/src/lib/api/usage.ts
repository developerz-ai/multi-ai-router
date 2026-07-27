import type { UsageOutcome } from "@multi-ai-router/core"
import type { FailureCount } from "../failure-classes"
import { request } from "./client"

// Usage reads, backed by `GET /api/admin/usage`.
//
// The wire shape differs from what this module hands the console in four ways,
// and each difference is deliberate rather than incidental:
//
//   - **Costs arrive as strings.** They are Postgres `numeric`, and serialising
//     them as JSON numbers would round money through a float. They are parsed
//     once here, at the edge, so no component has to know.
//   - **A label may be null**, with a `note` saying why: `deleted` when the key
//     or account is gone (usage rows outlive what they name), `none` when the
//     dimension did not apply — a key scoped `all` was placed by no pool. Both
//     still render, because spend that happened is still spend and hiding a row
//     would make the breakdown stop adding up to the total printed above it.
//   - **Percentiles are per group** on the wire and are folded into this
//     module\'s flat `UsageTotals`, which is the shape the tables already render.
//   - **`failures.byOutcome` is narrowed to the failures.** The server already
//     drops `success` from that list, and saying so in the type here means no
//     component has to carry a branch for a case the wire cannot contain.
//
// Every series is dense and aligned to `axis`: a quiet bucket is a zero, not a
// missing point, so two rows in a table are comparable at a glance.
//
// Core is imported **as a type only**, for the reason `api/usage-recent.ts`
// records at length: one runtime import of its Zod-backed vocabulary pulls Zod
// into this route's chunk.

export const USAGE_WINDOWS = ["today", "7d", "30d", "lifetime"] as const
export type UsageWindow = (typeof USAGE_WINDOWS)[number]

/**
 * A custom `from`/`to` range, both ISO-8601. The server already accepts this
 * (`services/usage-read/window.ts`) — it was only ever unreachable from the console.
 */
export interface UsageRangeInput {
  readonly from: string
  readonly to: string
}

/** What a caller may ask for: one of the four named windows, or an explicit range. */
export type UsageRange = UsageWindow | UsageRangeInput

/** What the server actually resolved the request to — `"custom"` is its own label, not a window. */
export type UsageWindowLabel = UsageWindow | "custom"

export function isCustomRange(range: UsageRange): range is UsageRangeInput {
  return typeof range === "object"
}

export function usageWindowLabel(window: UsageWindow): string {
  switch (window) {
    case "today":
      return "Today"
    case "7d":
      return "7 days"
    case "30d":
      return "30 days"
    case "lifetime":
      return "Lifetime"
  }
}

/** Same as `usageWindowLabel`, widened to the label a *resolved* summary can carry. */
export function usageSummaryWindowLabel(window: UsageWindowLabel): string {
  return window === "custom" ? "Custom range" : usageWindowLabel(window)
}

/** The measures every total and every breakdown row carries, in one shape. */
export interface UsageTotals {
  /** Client-facing requests. */
  readonly requests: number
  /** Upstream attempts. Reported beside `requests`, never merged into it. */
  readonly attempts: number
  readonly errors: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** Real money, from a priced model. */
  readonly costMetered: number
  /** Attributed spend on a subscription account. Never added to the above. */
  readonly costNotional: number
  readonly latencyP50Ms: number
  readonly latencyP95Ms: number
  /** The router's own added time. Budgeted at <5 ms p99; a regression is a bug. */
  readonly routerOverheadP95Ms: number
  /** Time to first byte. Budgeted at zero added TTFT — the number that catches a stream bug the
   *  overhead figure above cannot, because overhead is measured off the critical path and this is
   *  measured on it. */
  readonly ttfbP95Ms: number
}

/** One row of a leaderboard: a dimension member and its totals. */
export interface UsageBreakdownRow {
  readonly id: string
  readonly label: string
  /** Provider, policy, scope — whatever qualifies the label in that dimension. */
  readonly note: string
  readonly totals: UsageTotals
  /** Requests per bucket, for the inline sparkline. Same length as the series. */
  readonly series: readonly number[]
}

/**
 * One bucket of the headline series, undiscarded: `at` names the bucket so a chart can draw a
 * real x-axis, and `attempts`/`errors` ride beside `requests` so the chart can show a failover
 * chain running (attempts diverging from requests) or a bad window (errors climbing) — not just
 * request volume.
 */
export interface UsageChartPoint {
  readonly at: string
  readonly requests: number
  readonly attempts: number
  readonly errors: number
}

export type UsageDimension = "key" | "account" | "pool" | "model"

export const USAGE_DIMENSIONS = ["key", "account", "pool", "model"] as const

export function usageDimensionLabel(dimension: UsageDimension): string {
  switch (dimension) {
    case "key":
      return "Key"
    case "account":
      return "Account"
    case "pool":
      return "Pool"
    case "model":
      return "Model"
  }
}

/**
 * `totals.errors` taken apart by outcome — the answer to *which* failure that
 * error rate was.
 *
 * One percentage cannot tell an operator whether to wait for a window, top up a
 * balance, or widen a key's scope, and those are three different jobs with three
 * different HTTP statuses behind them (CLAUDE.md non-negotiable 7).
 */
export interface UsageFailureSplit {
  /**
   * Attempts the server's per-outcome scan covered — the denominator for every
   * share drawn from `byOutcome`, and deliberately not `totals.attempts`, which
   * is stitched from the rollup and would make the parts stop summing to the
   * whole.
   */
  readonly attempts: number
  /** Non-success attempts among them. The sum of `byOutcome`. */
  readonly errors: number
  /**
   * True when the window reaches past the raw rows these counts came from. The
   * counts are then a floor, and the panel says so rather than drawing a share
   * of a number missing its older half.
   */
  readonly partial: boolean
  /** One entry per failure outcome that actually occurred, biggest first. */
  readonly byOutcome: readonly FailureCount[]
}

export interface UsageSummary {
  readonly window: UsageWindowLabel
  /** `hour` for today (or any custom range under ~2 days), `day` for everything else. */
  readonly bucket: "hour" | "day"
  readonly from: string
  readonly to: string
  readonly totals: UsageTotals
  readonly failures: UsageFailureSplit
  /** One entry per bucket across the window, dense — a quiet bucket is a zero, not a gap. */
  readonly series: readonly UsageChartPoint[]
  readonly byKey: readonly UsageBreakdownRow[]
  readonly byAccount: readonly UsageBreakdownRow[]
  readonly byPool: readonly UsageBreakdownRow[]
  readonly byModel: readonly UsageBreakdownRow[]
}

export function breakdownFor(
  summary: UsageSummary,
  dimension: UsageDimension,
): readonly UsageBreakdownRow[] {
  switch (dimension) {
    case "key":
      return summary.byKey
    case "account":
      return summary.byAccount
    case "pool":
      return summary.byPool
    case "model":
      return summary.byModel
  }
}

/** Sums a set of rows. Pure, and the one place totals are derived from parts. */
export function sumTotals(rows: readonly UsageBreakdownRow[]): UsageTotals {
  return rows.reduce<UsageTotals>((acc, row) => addTotals(acc, row.totals), EMPTY_TOTALS)
}

export const EMPTY_TOTALS: UsageTotals = {
  requests: 0,
  attempts: 0,
  errors: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMetered: 0,
  costNotional: 0,
  latencyP50Ms: 0,
  latencyP95Ms: 0,
  routerOverheadP95Ms: 0,
  ttfbP95Ms: 0,
}

/**
 * Percentiles are not additive, so the maximum is taken rather than a sum —
 * an aggregate p95 cannot be computed from per-row p95s, and the largest
 * component is the only honest summary available without the raw distribution.
 */
function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    requests: a.requests + b.requests,
    attempts: a.attempts + b.attempts,
    errors: a.errors + b.errors,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costMetered: a.costMetered + b.costMetered,
    costNotional: a.costNotional + b.costNotional,
    latencyP50Ms: Math.max(a.latencyP50Ms, b.latencyP50Ms),
    latencyP95Ms: Math.max(a.latencyP95Ms, b.latencyP95Ms),
    routerOverheadP95Ms: Math.max(a.routerOverheadP95Ms, b.routerOverheadP95Ms),
    ttfbP95Ms: Math.max(a.ttfbP95Ms, b.ttfbP95Ms),
  }
}

// ------------------------------------------------------------------ the wire

/** Exactly what `GET /api/admin/usage` returns. Parsed into the types above. */
interface WireTotals {
  readonly requests: number
  readonly attempts: number
  readonly errors: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costMetered: string
  readonly costNotional: string
}

interface WireRow {
  readonly id: string | null
  readonly label: string | null
  readonly note: "deleted" | "none" | null
  readonly totals: WireTotals
  readonly latencyP50Ms: number | null
  readonly latencyP95Ms: number | null
  readonly routerOverheadP95Ms: number | null
  readonly series: readonly number[]
}

interface WireSummary {
  readonly window: string
  readonly bucket: "hour" | "day"
  readonly from: string
  readonly to: string
  readonly totals: WireTotals
  readonly latency: {
    readonly p50Ms: number | null
    readonly p95Ms: number | null
    readonly routerOverheadP95Ms: number | null
    readonly ttfbP95Ms: number | null
  }
  readonly failures: {
    readonly attempts: number
    readonly errors: number
    readonly partial: boolean
    readonly byOutcome: readonly { readonly outcome: UsageOutcome; readonly attempts: number }[]
  }
  readonly axis: readonly string[]
  readonly series: readonly {
    readonly at: string
    readonly requests: number
    readonly attempts: number
    readonly errors: number
  }[]
  readonly byKey: readonly WireRow[]
  readonly byAccount: readonly WireRow[]
  readonly byPool: readonly WireRow[]
  readonly byModel: readonly WireRow[]
}

export async function fetchUsageSummary(range: UsageRange): Promise<UsageSummary> {
  const query = isCustomRange(range) ? { from: range.from, to: range.to } : { window: range }
  const wire = await request<WireSummary>({ method: "GET", path: "/usage", query })

  return {
    // The server is the one source of truth for what it actually resolved the request to — a
    // custom range comes back labelled `"custom"`, a named window echoes its own name.
    window: wire.window as UsageWindowLabel,
    bucket: wire.bucket,
    from: wire.from,
    to: wire.to,
    totals: {
      ...parseTotals(wire.totals),
      latencyP50Ms: wire.latency.p50Ms ?? 0,
      latencyP95Ms: wire.latency.p95Ms ?? 0,
      routerOverheadP95Ms: wire.latency.routerOverheadP95Ms ?? 0,
      ttfbP95Ms: wire.latency.ttfbP95Ms ?? 0,
    },
    failures: parseFailures(wire.failures),
    series: wire.series.map((point) => ({
      at: point.at,
      requests: point.requests,
      attempts: point.attempts,
      errors: point.errors,
    })),
    byKey: wire.byKey.map(toRow),
    byAccount: wire.byAccount.map(toRow),
    byPool: wire.byPool.map(toRow),
    byModel: wire.byModel.map(toRow),
  }
}

/**
 * Narrows the split to what it can actually contain.
 *
 * `success` is dropped rather than trusted to be absent: the server filters it,
 * and one filter at the edge is cheaper than a `success` branch in every
 * consumer of the type. `errors` is recomputed from the rows that survived, so
 * the headline figure and the rows under it can never disagree.
 */
function parseFailures(failures: WireSummary["failures"]): UsageFailureSplit {
  const byOutcome = failures.byOutcome.filter(
    (row): row is FailureCount => row.outcome !== "success",
  )
  return {
    attempts: failures.attempts,
    errors: byOutcome.reduce((sum, row) => sum + row.attempts, 0),
    partial: failures.partial,
    byOutcome,
  }
}

function parseTotals(
  totals: WireTotals,
): Omit<UsageTotals, "latencyP50Ms" | "latencyP95Ms" | "routerOverheadP95Ms" | "ttfbP95Ms"> {
  return {
    requests: totals.requests,
    attempts: totals.attempts,
    errors: totals.errors,
    tokensIn: totals.tokensIn,
    tokensOut: totals.tokensOut,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costMetered: Number(totals.costMetered),
    costNotional: Number(totals.costNotional),
  }
}

/**
 * A missing label is rendered, never hidden. `null` becomes an explicit word so a table cell is
 * never blank and a reader never has to guess whether a row is broken or simply unattributed.
 */
function toRow(row: WireRow): UsageBreakdownRow {
  return {
    id: row.id ?? `none-${row.note ?? "unknown"}`,
    label: row.label ?? (row.note === "deleted" ? "(deleted)" : "(none)"),
    note: noteFor(row),
    series: row.series,
    totals: {
      ...parseTotals(row.totals),
      latencyP50Ms: row.latencyP50Ms ?? 0,
      latencyP95Ms: row.latencyP95Ms ?? 0,
      routerOverheadP95Ms: row.routerOverheadP95Ms ?? 0,
      // Not tracked per breakdown row on the wire, only for the summary as a whole — a per-row
      // TTFT would need a percentile scan per key/account/pool/model, which nobody has asked for.
      ttfbP95Ms: 0,
    },
  }
}

function noteFor(row: WireRow): string {
  if (row.note === "deleted") return "no longer exists"
  if (row.note === "none") return "not attributed"
  return ""
}
