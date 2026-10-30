import type { UsageHistoryRepository, UsageReportRepository } from "@multi-ai-router/db"
import { UsageWeekRowCeilingError } from "@multi-ai-router/db"
import { USAGE_REPORT_MAX_ROWS_CEILING } from "../../config/usage-report"
import { type AdminResult, invalid, notFound, ok } from "../admin/result"
import { buildWeeklyReport } from "./builder"
import { isoDay, lastCompleteWeek, parseReportWeek, type ReportWeek } from "./period"
import type { ReportKeyLabel, ReportPool, WeeklyReport } from "./types"

/**
 * Generating, storing and reading weekly reports. One code path builds a report: `generate` is
 * build plus insert, `preview` is build alone, so what an operator previews is what the task would
 * have stored.
 */

export interface UsageReportServiceDeps {
  readonly reports: UsageReportRepository
  readonly history: Pick<UsageHistoryRepository, "weekRows">
  /**
   * The key labels, live then tombstoned (`catalogLabels`). Only `keys` is read: the builder is
   * never handed account labels, so none can reach a stored payload.
   */
  readonly labels: () => Promise<{ readonly keys: ReadonlyMap<string, ReportKeyLabel> }>
  /** Pools as they stand now, for the overflow designation. */
  readonly pools: () => Promise<readonly ReportPool[]>
  /** `UPSTREAM_TIMEOUT_MS`: a non-streamed (or Agent-SDK) attempt's whole deadline. */
  readonly upstreamTimeoutMs: number
  /** `UPSTREAM_STREAM_TIMEOUT_MS`: a streamed HTTP attempt's whole deadline. */
  readonly upstreamStreamTimeoutMs: number
  /** `USAGE_REPORT_MAX_ROWS`: the week read's ceiling. Over it, building fails loudly. */
  readonly maxRows: number
  /** The most reports the list returns: enough weeks to cover the retention window. */
  readonly listLimit: number
  readonly now: () => Date
}

export interface StoredReportView {
  readonly periodStart: string
  readonly periodEnd: string
  readonly generatedAt: Date
  readonly deliveryStatus: string
  readonly deliveryAttempts: number
  readonly deliveredAt: Date | null
  readonly lastError: string | null
  readonly report: unknown
}

export interface UsageReportService {
  /** Stored reports, newest week first, without payloads. */
  list(): Promise<AdminResult<{ readonly reports: readonly unknown[] }>>
  /** One stored week by its Monday (`YYYY-MM-DD`): 400 when malformed or not a Monday, 404 when absent. */
  get(periodStart: string): Promise<AdminResult<StoredReportView>>
  /** Builds the last complete week as of now and stores nothing. */
  preview(): Promise<AdminResult<WeeklyReport>>
  /** Whether a report is already stored for the week starting `periodStart`. */
  exists(periodStart: string): Promise<boolean>
  /**
   * Builds the week and inserts it `ON CONFLICT (period_start) DO NOTHING`. `true` when this call
   * wrote the row; `false` when the week already had one (a concurrent generation won).
   */
  generate(week: ReportWeek, now: Date): Promise<boolean>
}

/** The week has more rows than `USAGE_REPORT_MAX_ROWS`; a report would be partial, so none is made. */
export class ReportTooLargeError extends Error {
  constructor(readonly maxRows: number) {
    super(
      maxRows >= USAGE_REPORT_MAX_ROWS_CEILING
        ? // At the cap there is nothing left to raise: pointing at the setting would send the
          // operator to a value boot refuses.
          `the week has more than ${maxRows} key x account x pool x model rows; USAGE_REPORT_MAX_ROWS is already at its ceiling of ${USAGE_REPORT_MAX_ROWS_CEILING}, so building this week needs a code change — until then the week is not reported`
        : `the week has more than ${maxRows} key x account x pool x model rows; raise USAGE_REPORT_MAX_ROWS (at most ${USAGE_REPORT_MAX_ROWS_CEILING}) to build it`,
    )
    this.name = "ReportTooLargeError"
  }
}

export function createUsageReportService(deps: UsageReportServiceDeps): UsageReportService {
  const build = async (week: ReportWeek, now: Date, preview = false): Promise<WeeklyReport> => {
    // The three reads run concurrently. `deps.labels` orders its own two reads (live keys, then
    // tombstones) so a key deleted mid-read is still named; the rows are one query.
    const [labels, pools, read] = await Promise.all([
      deps.labels(),
      deps.pools(),
      deps.history.weekRows({ from: week.start, to: week.end }, deps.maxRows).catch((error) => {
        if (error instanceof UsageWeekRowCeilingError) throw new ReportTooLargeError(deps.maxRows)
        throw error
      }),
    ])
    return buildWeeklyReport(read.rows, labels.keys, pools, {
      start: week.start,
      end: week.end,
      generatedAt: now,
      // The longer of the two is how late an attempt in flight at the boundary can still land; it is
      // what the coverage compares the real gap with. Stored under the field's original name.
      upstreamTimeoutMs: Math.max(deps.upstreamTimeoutMs, deps.upstreamStreamTimeoutMs),
      unpricedSince: read.unpricedSince,
      preview,
    })
  }

  return {
    list: async () => ok({ reports: await deps.reports.list(deps.listLimit) }),

    get: async (periodStart) => {
      const monday = parseReportWeek(periodStart)
      if (monday === undefined)
        return invalid("periodStart must be a Monday written as YYYY-MM-DD (UTC)")
      const row = await deps.reports.findByPeriodStart(isoDay(monday))
      if (row === undefined) return notFound(`no report is stored for the week of ${periodStart}`)
      const { id: _id, payload, ...rest } = row
      return ok({ ...rest, report: payload })
    },

    preview: async () => {
      const now = deps.now()
      try {
        return ok(await build(lastCompleteWeek(now), now, true))
      } catch (error) {
        if (error instanceof ReportTooLargeError) return invalid(error.message, "report_too_large")
        throw error
      }
    },

    exists: (periodStart) => deps.reports.exists(periodStart),

    generate: async (week, now) =>
      deps.reports.insertIfAbsent({
        periodStart: isoDay(week.start),
        periodEnd: isoDay(week.end),
        generatedAt: now,
        payload: await build(week, now),
      }),
  }
}
