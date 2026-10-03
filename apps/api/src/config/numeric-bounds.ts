import type { z } from "zod"

/** Bun/Node timers overflow to a near-immediate callback beyond this delay. */
export const MAX_TIMER_MS = 2_147_483_647
/** Non-timer lifetimes allow up to 68 years, with exact millisecond/Date arithmetic. */
export const MAX_DURATION_MS = MAX_TIMER_MS * 1_000

const TIMER_DURATIONS = new Set([
  "DB_POOL_IDLE_TIMEOUT_SECONDS",
  "DB_POOL_CONNECT_TIMEOUT_SECONDS",
  "DB_POOL_MAX_LIFETIME_SECONDS",
  "DB_POOL_CLOSE_TIMEOUT_SECONDS",
  "OAUTH_REFRESH_MIN_DELAY_SECONDS",
  // Also retires an in-flight Claude login subprocess through setTimeout.
  "RETENTION_OAUTH_STATE_MINUTES",
])

const units: ReadonlyArray<readonly [string, number]> = [
  ["_MS", 1],
  ["_SECONDS", 1_000],
  ["_MINUTES", 60_000],
  ["_HOURS", 3_600_000],
  ["_DAYS", 86_400_000],
]

/** Validate after all fields parse so a task's bound includes its configured positive jitter. */
export function validateNumericBounds(raw: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const jitter =
    typeof raw.SCHEDULER_JITTER_FRACTION === "number" ? raw.SCHEDULER_JITTER_FRACTION : 0.2
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "number") continue
    const unit = units.find(([suffix]) => name.endsWith(suffix))?.[1]
    if (unit === undefined) continue
    const scheduler = name === "JANITOR_INTERVAL_MINUTES" || name.endsWith("_INTERVAL_MINUTES")
    const catalog = name === "CATALOG_REFRESH_SECONDS"
    const timer = unit === 1 || TIMER_DURATIONS.has(name) || scheduler || catalog
    const spread = scheduler ? 1 + jitter : catalog ? 1.2 : 1
    const maximum = Math.floor((timer ? MAX_TIMER_MS : MAX_DURATION_MS) / (unit * spread))
    if (value > maximum) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: `must be at most ${maximum}: ${timer ? "timer delay including positive jitter" : "duration"} exceeds the supported millisecond range`,
      })
    }
  }
}
