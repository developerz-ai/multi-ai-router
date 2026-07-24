import type { UsageWindow } from "@multi-ai-router/db"
import { z } from "zod"

/**
 * Turning the console's window selection into an instant range.
 *
 * A pure function of `now`, so it is testable without waiting and cannot drift between the
 * totals query and the series query — both are built from one resolved window, not from two
 * separate readings of the clock.
 */

export const usageWindowQuery = z
  .object({
    window: z.enum(["today", "7d", "30d", "lifetime"]).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .refine((query) => !(query.window !== undefined && query.from !== undefined), {
    message: "pass either a named window or a from/to range, not both",
  })
  .refine((query) => query.from === undefined || query.to !== undefined, {
    message: "a custom range needs both from and to",
  })

export type UsageWindowQuery = z.infer<typeof usageWindowQuery>

export type UsageBucket = "hour" | "day"

export interface ResolvedWindow extends UsageWindow {
  readonly label: string
  /**
   * Bucket width for the sparkline. Chosen from the span rather than from the name, so a custom
   * range gets the same treatment a named one would: a 3-hour range in day buckets is one bar.
   */
  readonly bucket: UsageBucket
}

const DAY_MS = 24 * 60 * 60 * 1_000

/** Beyond about two days, hourly buckets are more points than a sparkline can show honestly. */
const HOURLY_MAX_SPAN_MS = 2 * DAY_MS

export function resolveWindow(query: UsageWindowQuery, now: Date): ResolvedWindow {
  if (query.from !== undefined && query.to !== undefined) {
    const from = new Date(query.from)
    const to = new Date(query.to)
    return { from, to, label: "custom", bucket: bucketFor(to.getTime() - from.getTime()) }
  }

  const window = query.window ?? "today"
  // `to` is always *now*, never the end of the day: a "today" total that included the rest of an
  // unfinished day would read as a drop every morning.
  switch (window) {
    case "today":
      return { from: startOfUtcDay(now), to: now, label: "today", bucket: "hour" }
    case "7d":
      return { from: new Date(now.getTime() - 7 * DAY_MS), to: now, label: "7d", bucket: "day" }
    case "30d":
      return { from: new Date(now.getTime() - 30 * DAY_MS), to: now, label: "30d", bucket: "day" }
    case "lifetime":
      // Epoch rather than the oldest row: one fewer query, and the retention sweep already bounds
      // how far back rows go, so "lifetime" means "everything still kept" either way.
      return { from: new Date(0), to: now, label: "lifetime", bucket: "day" }
  }
}

function bucketFor(spanMs: number): UsageBucket {
  return spanMs <= HOURLY_MAX_SPAN_MS ? "hour" : "day"
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}
