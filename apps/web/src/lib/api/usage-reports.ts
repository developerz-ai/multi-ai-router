import { request } from "./client"

// The stored weekly usage reports, backed by `GET /api/admin/usage/reports` (issue #227). The list
// carries no payload: a week, when it was generated, and where delivery stands. Read-only here;
// sending a report is the delivery task's job, not a console button.

/** The four states `usage_reports.delivery_status` can hold (`UsageReportDeliveryStatus` in core). */
export const REPORT_DELIVERY_STATUSES = ["pending", "not_configured", "sent", "failed"] as const
export type ReportDeliveryStatus = (typeof REPORT_DELIVERY_STATUSES)[number]

/**
 * `deliveryStatus` is a plain `string` on purpose: the column is `text`, not a Postgres enum, so
 * a later release can add a state without a migration. The console narrows it with
 * `reportDeliveryStatus` and shows an unrecognised value as written rather than guessing.
 */
export interface UsageReportListItem {
  /** `YYYY-MM-DD`, the Monday (UTC) the week starts. */
  readonly periodStart: string
  /** `YYYY-MM-DD`, exclusive: the next Monday. */
  readonly periodEnd: string
  readonly generatedAt: string
  readonly deliveryStatus: string
  readonly deliveryAttempts: number
  readonly deliveredAt: string | null
  /** On the wire, and deliberately never rendered: it can carry an upstream's error text. */
  readonly lastError: string | null
}

export function reportDeliveryStatus(value: string): ReportDeliveryStatus | undefined {
  return REPORT_DELIVERY_STATUSES.find((status) => status === value)
}

export async function fetchUsageReports(): Promise<readonly UsageReportListItem[]> {
  const body = await request<{ readonly reports: readonly UsageReportListItem[] }>({
    method: "GET",
    path: "/usage/reports",
  })
  return body.reports
}
