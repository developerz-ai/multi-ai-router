import { request } from "./client"

// Usage reads, backed by `GET /api/admin/usage`.
//
// The wire shape differs from what this module hands the console in three ways,
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
//
// Every series is dense and aligned to `axis`: a quiet bucket is a zero, not a
// missing point, so two rows in a table are comparable at a glance.

export const USAGE_IS_PLACEHOLDER = false

export const USAGE_WINDOWS = ["today", "7d", "30d", "lifetime"] as const
export type UsageWindow = (typeof USAGE_WINDOWS)[number]

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

export interface UsageSummary {
  readonly window: UsageWindow
  /** `hour` for today, `day` for everything else. */
  readonly bucket: "hour" | "day"
  readonly from: string
  readonly to: string
  readonly totals: UsageTotals
  /** Requests per bucket across the window. */
  readonly series: readonly number[]
  readonly byKey: readonly UsageBreakdownRow[]
  readonly byAccount: readonly UsageBreakdownRow[]
  readonly byPool: readonly UsageBreakdownRow[]
  readonly byModel: readonly UsageBreakdownRow[]
  /** True while these numbers are generated. The banner is driven off this. */
  readonly placeholder: boolean
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
  readonly axis: readonly string[]
  readonly series: readonly { readonly at: string; readonly requests: number }[]
  readonly byKey: readonly WireRow[]
  readonly byAccount: readonly WireRow[]
  readonly byPool: readonly WireRow[]
  readonly byModel: readonly WireRow[]
}

export async function fetchUsageSummary(window: UsageWindow): Promise<UsageSummary> {
  const wire = await request<WireSummary>({ method: "GET", path: "/usage", query: { window } })

  return {
    window,
    bucket: wire.bucket,
    from: wire.from,
    to: wire.to,
    totals: {
      ...parseTotals(wire.totals),
      latencyP50Ms: wire.latency.p50Ms ?? 0,
      latencyP95Ms: wire.latency.p95Ms ?? 0,
      routerOverheadP95Ms: wire.latency.routerOverheadP95Ms ?? 0,
    },
    series: wire.series.map((point) => point.requests),
    byKey: wire.byKey.map(toRow),
    byAccount: wire.byAccount.map(toRow),
    byPool: wire.byPool.map(toRow),
    byModel: wire.byModel.map(toRow),
    placeholder: USAGE_IS_PLACEHOLDER,
  }
}

function parseTotals(
  totals: WireTotals,
): Omit<UsageTotals, "latencyP50Ms" | "latencyP95Ms" | "routerOverheadP95Ms"> {
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
    },
  }
}

function noteFor(row: WireRow): string {
  if (row.note === "deleted") return "no longer exists"
  if (row.note === "none") return "not attributed"
  return ""
}
