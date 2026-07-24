// ─────────────────────────────────────────────────────────────────────────────
// PLACEHOLDER DATA. THERE IS NO USAGE READ API YET.
//
// Every figure this module returns is generated locally from a fixed seed. It
// is not a cache, not a sample, and not derived from anything the router
// measured. `UsageSummary.placeholder` is `true` on every value, and the Usage
// surface renders a standing banner off that flag — nothing in this console may
// present these numbers without saying where they came from.
//
// **The swap is this one file.** The types below are the contract the console
// already renders against; when the endpoint lands, `fetchUsageSummary` becomes
// a `request()` call and `placeholder` becomes `false`. No route, component or
// query key changes.
//
// The endpoint this was written against:
//
//   GET /api/admin/usage?window=today|7d|30d|lifetime
//   GET /api/admin/usage?from=<iso>&to=<iso>          (custom window)
//   → UsageSummary, with `placeholder` absent or false
//
// The shape matters in three specific ways, each of which is a rule from
// CLAUDE.md rather than a preference:
//   - `requests` and `attempts` are separate fields and are never summed. A
//     failover chain of three is one request and three attempts.
//   - `costMetered` and `costNotional` are separate fields and are never
//     summed. A subscription account has no per-token price, only an
//     attribution.
//   - `tokensIn` is the prompt tokens *excluding* cache; total prompt size is
//     `tokensIn + cacheReadTokens + cacheWriteTokens`, which is why all three
//     travel together.
// ─────────────────────────────────────────────────────────────────────────────

export const USAGE_IS_PLACEHOLDER = true

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

// ---------------------------------------------------------------- generation

const BUCKETS: Readonly<Record<UsageWindow, number>> = {
  today: 24,
  "7d": 7,
  "30d": 30,
  lifetime: 30,
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** Deterministic per seed, so a re-render never reshuffles the numbers. */
function seeded(seed: string): () => number {
  let state = 2166136261
  for (const char of seed) {
    state = Math.imul(state ^ char.charCodeAt(0), 16777619)
  }
  return () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507)
    state = Math.imul(state ^ (state >>> 13), 3266489909)
    state = state ^ (state >>> 16)
    return (state >>> 0) / 4294967296
  }
}

const MEMBERS: Readonly<Record<UsageDimension, readonly (readonly [string, string])[]>> = {
  key: [
    ["ci-pipeline", "scope: all"],
    ["dev-laptops", "scope: 2 pools"],
    ["nightly-evals", "scope: 3 accounts"],
  ],
  account: [
    ["claude-max-01", "anthropic-oauth"],
    ["claude-max-02", "anthropic-oauth"],
    ["openai-team", "openai-api"],
    ["openrouter-fallback", "openrouter"],
  ],
  pool: [
    ["claude-subs", "sticky"],
    ["overflow", "priority-failover"],
  ],
  model: [
    ["claude-sonnet-4-5", "anthropic"],
    ["claude-opus-4-1", "anthropic"],
    ["gpt-5", "openai-chat"],
  ],
}

function makeSeries(random: () => number, buckets: number, scale: number): readonly number[] {
  return Array.from({ length: buckets }, () => Math.round(random() * scale + scale * 0.15))
}

function totalsFrom(series: readonly number[], random: () => number): UsageTotals {
  const requests = series.reduce((sum, value) => sum + value, 0)
  const attempts = requests + Math.round(requests * random() * 0.18)
  return {
    requests,
    attempts,
    errors: Math.round(attempts * random() * 0.06),
    tokensIn: requests * Math.round(420 + random() * 900),
    tokensOut: requests * Math.round(180 + random() * 500),
    cacheReadTokens: requests * Math.round(random() * 2400),
    cacheWriteTokens: requests * Math.round(random() * 320),
    costMetered: requests * (random() * 0.004),
    costNotional: requests * (random() * 0.006),
    latencyP50Ms: Math.round(600 + random() * 900),
    latencyP95Ms: Math.round(2200 + random() * 3000),
    routerOverheadP95Ms: Math.round(1 + random() * 3),
  }
}

function breakdown(
  dimension: UsageDimension,
  window: UsageWindow,
  buckets: number,
): readonly UsageBreakdownRow[] {
  return MEMBERS[dimension].map(([label, note], index) => {
    const random = seeded(`${dimension}:${label}:${window}`)
    const series = makeSeries(random, buckets, 40 / (index + 1))
    return {
      id: `${dimension}-${label}`,
      label,
      note,
      series,
      totals: totalsFrom(series, random),
    }
  })
}

/**
 * The function that becomes a `request()` call. Async today only so the swap
 * changes nothing about how the query layer calls it.
 */
export async function fetchUsageSummary(window: UsageWindow): Promise<UsageSummary> {
  const buckets = BUCKETS[window]
  const byAccount = breakdown("account", window, buckets)
  const to = new Date()
  const spanMs = window === "today" ? buckets * HOUR_MS : buckets * DAY_MS

  return {
    window,
    bucket: window === "today" ? "hour" : "day",
    from: new Date(to.getTime() - spanMs).toISOString(),
    to: to.toISOString(),
    totals: sumTotals(byAccount),
    series: Array.from({ length: buckets }, (_, index) =>
      byAccount.reduce((sum, row) => sum + (row.series[index] ?? 0), 0),
    ),
    byKey: breakdown("key", window, buckets),
    byAccount,
    byPool: breakdown("pool", window, buckets),
    byModel: breakdown("model", window, buckets),
    placeholder: USAGE_IS_PLACEHOLDER,
  }
}
