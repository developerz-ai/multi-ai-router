import type { UsageHistoryRepository, UsageReportRepository } from "@multi-ai-router/db"
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
  /** `USAGE_REPORT_SETTLE_MINUTES`, recorded in the report's coverage. */
  readonly settleMinutes: number
  /** `UPSTREAM_TIMEOUT_MS`, compared with the settle margin in the report's coverage. */
  readonly upstreamTimeoutMs: number
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

export function createUsageReportService(deps: UsageReportServiceDeps): UsageReportService {
  const build = async (week: ReportWeek, now: Date): Promise<WeeklyReport> => {
    // Labels first: live keys, then tombstones (`catalogLabels` orders its own reads), so a key
    // deleted mid-read is still named. The rows are one query.
    const [labels, pools, read] = await Promise.all([
      deps.labels(),
      deps.pools(),
      deps.history.weekRows({ from: week.start, to: week.end }),
    ])
    return buildWeeklyReport(read.rows, labels.keys, pools, {
      start: week.start,
      end: week.end,
      generatedAt: now,
      settleMinutes: deps.settleMinutes,
      upstreamTimeoutMs: deps.upstreamTimeoutMs,
      unpricedSince: read.unpricedSince,
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

    preview: async () => ok(await build(lastCompleteWeek(deps.now()), deps.now())),

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
