import type { UsageTotals } from "@multi-ai-router/db"
import type { UsageFailures } from "./failures"

export interface UsageSummary {
  readonly window: string
  readonly bucket: "hour" | "day"
  readonly from: string
  readonly to: string
  readonly totals: UsageTotals
  readonly coverage: UsageCoverage
  readonly latency: {
    readonly p50Ms: number | null
    readonly p95Ms: number | null
    readonly routerOverheadP95Ms: number | null
    readonly ttfbP95Ms: number | null
  }
  /**
   * Retained-detail errors taken apart by outcome — which of `429`, `402` and `403` that error rate
   * actually was. One percentage cannot tell an operator whether to wait, to top up, or to widen a
   * scope, and those are the three answers (`failures.ts`).
   */
  readonly failures: UsageFailures
  /** Bucket starts every series is plotted against, dense — a quiet bucket is a zero, not a gap. */
  readonly axis: readonly string[]
  /** One entry per axis point, always. A bucket with no traffic is zeros, never a missing entry. */
  readonly series: readonly UsageSeriesEntry[]
  readonly byKey: readonly UsageBreakdownRow[]
  readonly byAccount: readonly UsageBreakdownRow[]
  readonly byPool: readonly UsageBreakdownRow[]
  readonly byModel: readonly UsageBreakdownRow[]
}

export interface UsageSeriesEntry {
  readonly at: string
  readonly requests: number
  readonly attempts: number
  readonly errors: number
}

export interface UsageBreakdownRow {
  readonly id: string | null
  /** Human name. `null` when the subject is gone or the dimension did not apply. */
  readonly label: string | null
  /** Why the label is absent, so the console never has to guess. */
  readonly note: "deleted" | "none" | null
  readonly totals: UsageTotals
  /** This group's percentiles. A global p95 cannot answer "which account is slow". */
  readonly latencyP50Ms: number | null
  readonly latencyP95Ms: number | null
  readonly routerOverheadP95Ms: number | null
  /** Requests per bucket, aligned to `axis`, so two rows are comparable at a glance. */
  readonly series: readonly number[]
}

/**
 * Display names for every id a breakdown can carry, read once per summary.
 *
 * Maps rather than per-id lookups: a breakdown can be hundreds of rows, and resolving each one
 * separately is how an admin screen quietly becomes N queries.
 */
export interface UsageLabelSets {
  readonly keys: ReadonlyMap<string, string>
  readonly accounts: ReadonlyMap<string, string>
  readonly pools: ReadonlyMap<string, string>
}

export interface UsageCoverage {
  readonly timeBasis: "event-time"
  readonly requestsBasis: "terminal" | "mixed-legacy"
  readonly historicalPrecision: "day"
  readonly legacy: boolean
  readonly incomplete: boolean
  readonly bucketWidth: number
  readonly maxChartPoints: number
  readonly retainedDetail: {
    readonly from: string | null
    readonly to: string | null
    readonly attempts: number
    readonly totalAttempts: number
    readonly partial: boolean
  }
  readonly breakdown: {
    readonly maxRows: number
    readonly truncated: readonly string[]
  }
}
