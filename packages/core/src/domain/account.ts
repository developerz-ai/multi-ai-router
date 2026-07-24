import { z } from "zod"

/**
 * Account lifecycle states. `cooling_down` and `exhausted` are never conflated: a clock fixes
 * the first, only a human fixes the second. Only `active` accounts survive candidate filtering.
 */
export const AccountStatus = z.enum([
  "active",
  "disabled",
  "cooling_down",
  "exhausted",
  "needs_reauth",
])
export type AccountStatus = z.infer<typeof AccountStatus>

/**
 * The quota windows an Account can hold. A Claude subscription has several running concurrently
 * and resetting independently, and the account is blocked by whichever one is spent.
 */
export const QuotaWindowKind = z.enum([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
])
export type QuotaWindowKind = z.infer<typeof QuotaWindowKind>

/**
 * Where a utilization reading comes from — a first-class distinction, not a provider detail.
 *
 * - `continuous` — a real percentage at any point in the window. The only kind `quota-aware` can
 *   rank on.
 * - `threshold-triggered` — an alarm that fires only near the limit. Reads `null` for most of a
 *   window; good for tripping the breaker, useless for ranking.
 * - `none` — no signal at all.
 *
 * Always carried, because an empty gauge from a threshold-triggered source is correct and reads
 * as broken.
 */
export const UtilizationSource = z.enum(["continuous", "threshold-triggered", "none"])
export type UtilizationSource = z.infer<typeof UtilizationSource>

/**
 * How trustworthy a reset timestamp is. Always displayed next to the countdown — a guessed
 * reset shown as fact is worse than no reset at all.
 */
export const ResetSource = z.enum(["provider-reported", "estimated", "unknown"])
export type ResetSource = z.infer<typeof ResetSource>

/**
 * One window's quota state. `utilization` is optional on purpose: a threshold-triggered source
 * reports nothing until consumption nears the limit, so an absent reading is a normal state for
 * most of a window, not a fault — which is exactly why `utilizationSource` travels with it.
 *
 * An `exhausted` Account has no reset by definition, so `resetsAt` is absent there and the UI
 * shows "needs top-up" rather than a countdown.
 */
export const QuotaWindowState = z.object({
  window: QuotaWindowKind,
  utilization: z.number().min(0).max(1).optional(),
  utilizationSource: UtilizationSource,
  resetsAt: z.date().optional(),
  resetSource: ResetSource,
  lastCheckedAt: z.date(),
})
export type QuotaWindowState = z.infer<typeof QuotaWindowState>
