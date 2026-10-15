/**
 * The weekly usage report (issue #227): a pure builder over the week read, the calendar it keys
 * on, and the service that generates, stores and reads it. Distinct from `usage-read/`, which
 * answers live windows; this stores one immutable report per UTC week.
 */

export { buildWeeklyReport } from "./builder"
export type { ReportWeek } from "./period"
export {
  DAY_MS,
  isoDay,
  lastCompleteWeek,
  latestMonday,
  parseReportWeek,
  reportAnchor,
  WEEK_MS,
} from "./period"
export type { StoredReportView, UsageReportService, UsageReportServiceDeps } from "./service"
export { createUsageReportService } from "./service"
export type {
  ReportCaveat,
  ReportCoverage,
  ReportKeyLabel,
  ReportLine,
  ReportMeasures,
  ReportModelLine,
  ReportOverflowLine,
  ReportPeriod,
  ReportPool,
  ReportSection,
  WeeklyReport,
} from "./types"
