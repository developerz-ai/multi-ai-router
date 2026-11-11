import { atLeastOne, wholeNumber } from "./fields"

export const USAGE_READ_ENV_FIELDS = {
  USAGE_CHART_MAX_POINTS: atLeastOne
    .refine((value) => value >= 2 && value <= 2_000, "must be between 2 and 2000")
    .optional(),
  USAGE_BREAKDOWN_MAX_ROWS: atLeastOne
    .refine((value) => value <= 1_000, "must be at most 1000")
    .optional(),
  // The rows are fetched into memory before the body streams, so the ceiling bounds the heap.
  USAGE_EXPORT_MAX_ROWS: atLeastOne
    .refine((value) => value <= 100_000, "must be at most 100000")
    .optional(),
  // Zero is a setting: every summary read goes to Postgres.
  USAGE_SUMMARY_CACHE_SECONDS: wholeNumber.optional(),
}

export function readUsageReadEnv(raw: {
  USAGE_CHART_MAX_POINTS?: number
  USAGE_BREAKDOWN_MAX_ROWS?: number
  USAGE_EXPORT_MAX_ROWS?: number
  USAGE_SUMMARY_CACHE_SECONDS?: number
}) {
  return {
    usageRead: {
      maxChartPoints: raw.USAGE_CHART_MAX_POINTS ?? 400,
      breakdownMaxRows: raw.USAGE_BREAKDOWN_MAX_ROWS ?? 100,
      exportMaxRows: raw.USAGE_EXPORT_MAX_ROWS ?? 50_000,
      // A console poll and a dashboard open at once share one summary instead of two snapshots.
      summaryCacheMs: (raw.USAGE_SUMMARY_CACHE_SECONDS ?? 10) * 1_000,
    },
  }
}
