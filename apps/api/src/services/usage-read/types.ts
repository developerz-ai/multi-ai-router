import type { KeyOwnerKind } from "@multi-ai-router/core"
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
  readonly byKey: readonly UsageKeyRow[]
  readonly byAccount: readonly UsageBreakdownRow[]
  readonly byPool: readonly UsageBreakdownRow[]
  readonly byModel: readonly UsageBreakdownRow[]
  /**
   * Folded on (owner kind, owner) in SQL before the row cap. Attribution follows each key's
   * CURRENT label, so relabelling a key moves its whole history between rows.
   */
  readonly byOwner: readonly UsageOwnerRow[]
  /** Folded on the tool slug, with the same non-owner buckets and the same current-label rule. */
  readonly byTool: readonly UsageBreakdownRow[]
}

export interface UsageSeriesEntry {
  readonly at: string
  readonly requests: number
  readonly attempts: number
  readonly errors: number
}

export interface UsageBreakdownRow {
  readonly id: string | null
  /** Human name. `null` when the subject is gone (no live row and, for a key, no tombstone) or the dimension did not apply. */
  readonly label: string | null
  /**
   * Why the label is absent, so the console never has to guess. `unassigned` exists only on the
   * owner and tool breakdowns: a key that is there but names no owner (or tool).
   */
  readonly note: "deleted" | "none" | "unassigned" | null
  readonly totals: UsageTotals
  /** This group's percentiles. A global p95 cannot answer "which account is slow". */
  readonly latencyP50Ms: number | null
  readonly latencyP95Ms: number | null
  readonly routerOverheadP95Ms: number | null
  /** Requests per bucket, aligned to `axis`, so two rows are comparable at a glance. */
  readonly series: readonly number[]
}

export interface UsageKeyRow extends UsageBreakdownRow {
  /**
   * True only when the key survives solely as a tombstone: its row was purged or deleted, its name
   * and attribution remain. False for a live key and for the `deleted` and `none` rows, so `note`
   * keeps meaning "why the label is absent" and nothing else.
   */
  readonly retired: boolean
}

export interface UsageOwnerRow extends UsageBreakdownRow {
  /** Null on the non-owner buckets and on an owner whose key carries no kind. */
  readonly ownerKind: KeyOwnerKind | null
}

/**
 * What the loader knows about a key: read from the live row, else its tombstone. Only `name`
 * reaches the wire in this slice; owner, kind and tool ride along for the consumers that follow.
 */
export interface KeyLabel {
  readonly name: string
  readonly owner: string | null
  readonly ownerKind: KeyOwnerKind | null
  readonly tool: string | null
  /** True when only the tombstone remains (the live row is gone). */
  readonly retired: boolean
}

/** `UsageLabelSets` projected to the names the wire carries; built once per request. */
export interface DisplayNames {
  readonly keys: ReadonlyMap<string, string>
  readonly accounts: ReadonlyMap<string, string>
  readonly pools: ReadonlyMap<string, string>
}

/**
 * Display names for every id a breakdown can carry, read once per summary.
 *
 * Maps rather than per-id lookups: a breakdown can be hundreds of rows, and resolving each one
 * separately is how an admin screen quietly becomes N queries.
 */
export interface UsageLabelSets {
  readonly keys: ReadonlyMap<string, KeyLabel>
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
