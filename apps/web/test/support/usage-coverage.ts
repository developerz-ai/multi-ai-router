import type { UsageCoverage } from "../../src/lib/api/usage"

export function usageCoverage(attempts = 0): UsageCoverage {
  return {
    timeBasis: "event-time",
    requestsBasis: "terminal",
    historicalPrecision: "day",
    legacy: false,
    incomplete: false,
    bucketWidth: 1,
    maxChartPoints: 400,
    retainedDetail: {
      from: "2026-07-18T00:00:00.000Z",
      to: "2026-07-25T00:00:00.000Z",
      attempts,
      totalAttempts: attempts,
      partial: false,
    },
    breakdown: { maxRows: 100, truncated: [] },
  }
}
