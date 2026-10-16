// The windows a usage read can be asked for, and the labels the page prints for them. Split out
// of `usage.ts` so that module stays under the file-size cap as the dimensions grow.

export const USAGE_WINDOWS = ["today", "7d", "30d", "lifetime"] as const
export type UsageWindow = (typeof USAGE_WINDOWS)[number]

/**
 * A custom `from`/`to` range, both ISO-8601. The server already accepts this
 * (`services/usage-read/window.ts`) — it was only ever unreachable from the console.
 */
export interface UsageRangeInput {
  readonly from: string
  readonly to: string
}

/** What a caller may ask for: one of the four named windows, or an explicit range. */
export type UsageRange = UsageWindow | UsageRangeInput

/** What the server actually resolved the request to — `"custom"` is its own label, not a window. */
export type UsageWindowLabel = UsageWindow | "custom"

export function isCustomRange(range: UsageRange): range is UsageRangeInput {
  return typeof range === "object"
}

export function usageWindowLabel(window: UsageWindow): string {
  switch (window) {
    case "today":
      return "Today"
    case "7d":
      return "7 days"
    case "30d":
      return "30 days"
    case "lifetime":
      return "Lifetime"
  }
}

/** Same as `usageWindowLabel`, widened to the label a *resolved* summary can carry. */
export function usageSummaryWindowLabel(window: UsageWindowLabel): string {
  return window === "custom" ? "Custom range" : usageWindowLabel(window)
}
