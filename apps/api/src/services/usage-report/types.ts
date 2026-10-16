import type { KeyOwnerKind } from "@multi-ai-router/core"

/**
 * The stored weekly report. This is the whole contract delivery (#229) renders from, so it never
 * re-reads live state: every section line carries owner, owner kind and tool, and every overflow
 * line carries the key name and the pool name. **Never an account label or id** (labels are often
 * email addresses); the builder is not handed them.
 */

/** What the builder knows of a key: `KeyLabel` projected to the fields a report may use. */
export interface ReportKeyLabel {
  readonly name: string
  readonly owner: string | null
  readonly ownerKind: KeyOwnerKind | null
  readonly tool: string | null
  /** Present on the real label; tolerated here and ignored: a tombstoned key still attributes. */
  readonly retired?: boolean
}

/** A pool as it stands when the report is generated. */
export interface ReportPool {
  readonly id: string
  readonly name: string
  readonly overflowAccountId: string | null
  /** The provider id of that overflow account (not its label), for the overflow line. */
  readonly overflowProvider: string | null
}

/**
 * What the builder is told about the week: the window, the generation instant and the facts that
 * qualify the figures. Passed in rather than read, so the builder has no clock and no env.
 */
export interface ReportPeriod {
  readonly start: Date
  readonly end: Date
  readonly generatedAt: Date
  readonly upstreamTimeoutMs: number
  /** First fully measured day of the unpriced measure, `YYYY-MM-DD`, or `infinity`. */
  readonly unpricedSince: string
  /**
   * True only for the preview build. A preview stores nothing, so its settle caveat says an
   * attempt "would be missed in a stored report" instead of claiming it "is missed for good".
   */
  readonly preview?: boolean
}

/**
 * The measures of one line. METERED and NOTIONAL are separate fields and are never added
 * together anywhere: a subscription has no per-token price, only an attribution. Money is a
 * `numeric(24,6)` string, summed exactly. `unpricedAttempts` is `null` when the week was not
 * measured, never 0.
 */
export interface ReportMeasures {
  readonly requests: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costMetered: string
  readonly costNotional: string
  readonly unpricedAttempts: number | null
}

export interface ReportLine extends ReportMeasures {
  readonly owner: string
  /** `null` only in the unknown-kind section. */
  readonly ownerKind: KeyOwnerKind | null
  /** `null`: the owner's key names no tool (the same cell `byTool` calls unassigned). */
  readonly tool: string | null
}

export interface ReportSection {
  readonly lines: readonly ReportLine[]
  readonly totals: ReportMeasures
}

export interface ReportModelLine extends ReportMeasures {
  readonly model: string | null
}

/** One service key's share of attempts that landed on a pool's overflow account. */
export interface ReportOverflowLine {
  readonly keyName: string
  readonly owner: string | null
  readonly ownerKind: KeyOwnerKind | null
  readonly tool: string | null
  readonly poolName: string
  /** The provider id of the pool's overflow account, e.g. `anthropic`. Never the account's label. */
  readonly provider: string | null
  readonly overflowAttempts: number
  /** All of the key's attempts in the pool, the denominator. */
  readonly attempts: number
  /** `overflowAttempts / attempts`, 0..1. */
  readonly share: number
}

export interface ReportCaveat {
  readonly code: "unpriced_share" | "overflow_designation" | "coverage" | "dating" | "settle_margin"
  readonly text: string
}

export interface ReportCoverage {
  readonly timeBasis: "event-time"
  readonly requestsDatedBy: "settled-at"
  readonly attemptsDatedBy: "started-at"
  readonly upstreamTimeoutMs: number
  /**
   * Whole minutes between the end of the week and the instant the report was generated: the real
   * gap (the schedule's weekday, hour and settle margin, plus however late the tick ran), which for
   * a preview is whenever it was asked for. Not the configured margin.
   */
  readonly generatedAfterPeriodEndMinutes: number
  /** False when an upstream attempt can outlive that gap and be missed for good. */
  readonly settleCoversUpstreamTimeout: boolean
  readonly unpricedSince: string
  readonly unpricedMeasured: "none" | "partial" | "full"
}

export interface WeeklyReport {
  readonly version: 1
  /** `YYYY-MM-DD` UTC; `end` is the exclusive next Monday. */
  readonly period: { readonly start: string; readonly end: string }
  readonly generatedAt: string
  readonly coverage: ReportCoverage
  /** What each measure means, so a renderer labels METERED and NOTIONAL the same way everywhere. */
  readonly measureLabels: Readonly<Record<keyof ReportMeasures, string>>
  readonly totals: ReportMeasures
  readonly sections: {
    readonly people: ReportSection
    readonly services: ReportSection
    readonly unknownKind: ReportSection
  }
  /** Outside the owner sections: each its own totals, so sections plus buckets equal `totals`. */
  readonly buckets: {
    /** A labelled key that names no owner. */
    readonly unassigned: ReportMeasures
    /** A key id with no live row and no tombstone. */
    readonly deleted: ReportMeasures
    /** No key at all (`api_key_id` is null). */
    readonly none: ReportMeasures
  }
  readonly topModels: readonly ReportModelLine[]
  readonly overflow: readonly ReportOverflowLine[]
  readonly caveats: readonly ReportCaveat[]
}
