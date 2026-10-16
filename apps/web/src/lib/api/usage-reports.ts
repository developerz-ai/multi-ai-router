import { request } from "./client"

// The stored weekly usage reports, backed by `GET /api/admin/usage/reports` (issue #227). The list
// carries no payload: a week, when it was generated, and where delivery stands. Delivery itself is
// the task's job; the one console control is `deliverUsageReport` (issue #229), which re-sends a
// stored week through the same claim the task uses.

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

/**
 * What `POST /usage/reports/:periodStart/deliver` answers (issue #229). A *failed* re-send is a
 * 200 whose `deliveryStatus` says `failed` and whose `lastError` carries the redacted reason —
 * never an HTTP error — so the console renders the outcome rather than a request failure. The
 * only HTTP failures are the 400/404/409 of a bad week, an absent row or a lost claim.
 */
export interface UsageReportDeliveryView {
  readonly periodStart: string
  readonly deliveryStatus: string
  readonly deliveryAttempts: number
  readonly deliveredAt: string | null
  readonly lastError?: string
}

/** Re-sends one stored week to the Discord webhook. The server claims before it posts. */
export function deliverUsageReport(periodStart: string): Promise<UsageReportDeliveryView> {
  return request<UsageReportDeliveryView>({
    method: "POST",
    path: `/usage/reports/${encodeURIComponent(periodStart)}/deliver`,
  })
}
