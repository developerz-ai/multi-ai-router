import { atLeastOne } from "./fields"

export const USAGE_READ_ENV_FIELDS = {
  USAGE_CHART_MAX_POINTS: atLeastOne
    .refine((value) => value >= 2 && value <= 2_000, "must be between 2 and 2000")
    .optional(),
  USAGE_BREAKDOWN_MAX_ROWS: atLeastOne
    .refine((value) => value <= 1_000, "must be at most 1000")
    .optional(),
}

export function readUsageReadEnv(raw: {
  USAGE_CHART_MAX_POINTS?: number
  USAGE_BREAKDOWN_MAX_ROWS?: number
}) {
  return {
    usageRead: {
      maxChartPoints: raw.USAGE_CHART_MAX_POINTS ?? 400,
      breakdownMaxRows: raw.USAGE_BREAKDOWN_MAX_ROWS ?? 100,
    },
  }
}
