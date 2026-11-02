import type { ReportDeliveryService, UsageReportService } from "../../src/services/usage-report"

function unreachable(): never {
  throw new Error("this test must not call the usage report service")
}

export function unreachableUsageReports(): UsageReportService {
  return {
    list: unreachable,
    get: unreachable,
    preview: unreachable,
    exists: unreachable,
    generate: unreachable,
  }
}

export function unreachableReportDelivery(): ReportDeliveryService {
  return {
    deliverDue: unreachable,
    redeliver: unreachable,
  }
}
