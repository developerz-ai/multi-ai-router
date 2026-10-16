/**
 * The weekly usage report (issue #227): a pure builder over the week read, the calendar it keys
 * on, and the service that generates, stores and reads it. Distinct from `usage-read/`, which
 * answers live windows; this stores one immutable report per UTC week.
 */

export { buildWeeklyReport } from "./builder"
export type {
  DueDelivery,
  RedeliverView,
  ReportDeliveryDeps,
  ReportDeliveryService,
  ReportDeliveryStore,
} from "./delivery"
export { createReportDeliveryService } from "./delivery"
export * from "./discord-limits"
export type { DiscordDelivery, DiscordWebhookPayload } from "./discord-render"
export { renderDiscordDelivery, usageWindowUrl } from "./discord-render"
export { weeklyReportPayload } from "./payload-schema"
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
export { renderReportCsv, reportCsvFilename } from "./report-csv"
export type { StoredReportView, UsageReportService, UsageReportServiceDeps } from "./service"
export { createUsageReportService, ReportTooLargeError } from "./service"
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
