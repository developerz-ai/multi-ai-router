import type { QuotaWindowView } from "./api/types"

// The router's own measurement of a quota window — tokens counted here against a ceiling the
// operator typed — as opposed to a figure the provider reported. Split out of `quota-windows.ts`,
// which describes a window; this answers only "is there a measured reading, and what is it".

/**
 * What a bar drawn from *our own* counting says about itself.
 *
 * The distinction is the whole point and it is stated wherever the bar is: the provider published
 * no number, so this is the router's measurement against a ceiling the operator typed. It can be
 * wrong in both directions — Anthropic meters differently than we count, and the ceiling is a
 * guess — which is exactly why it never reaches routing.
 */
export const MEASURED_NOTE =
  "Measured by this router against the limit you configured — not a figure the provider reported. Anthropic publishes no numeric limit and counts differently than we do."

/**
 * `0..1` of the configured ceiling, or null when either half is missing.
 *
 * Checks for *finite numbers* rather than `!== null`: an older router, or any response that simply
 * omits these fields, delivers `undefined` — which slips past a null check and turns the division
 * into `NaN`, and `NaN !== null` is true, so a gauge would render an unread window as a filled bar
 * with a nonsense label. Both fields are validated, not assumed.
 */
export function measuredFraction(window: QuotaWindowView): number | null {
  const used = window.tokensUsed
  const limit = window.tokenLimit
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return null
  if (used === null || limit === null || limit <= 0) return null
  return Math.min(1, Math.max(0, used / limit))
}

/**
 * `"1.2M / 3M"` — the counts, because a bare percentage hides which ceiling it is a share of. Null
 * with no reading, which the caller renders the way it renders any unread gauge.
 */
export function measuredText(window: QuotaWindowView): string | null {
  const used = window.tokensUsed
  const limit = window.tokenLimit
  // Same validation as the fraction: the text and the bar must never disagree about whether there
  // is a reading at all.
  if (measuredFraction(window) === null || used === null || limit === null) return null
  return `${compactTokens(used)} / ${compactTokens(limit)}`
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

/**
 * The window's consumption curve, or empty.
 *
 * Validated the same way `measuredFraction` is and for the same reason: an older router, or any
 * response that omits the field, delivers `undefined`, and a chart handed `undefined` renders an
 * empty box that looks like a broken component rather than an absent measurement. A single point
 * is dropped too — one slice is a dot, not a trend, and `Sparkline` would draw it as a flat line
 * across the whole width, which claims a shape nobody measured.
 */
export function measuredSeries(window: QuotaWindowView): readonly number[] {
  const series = window.tokenSeries
  if (!Array.isArray(series) || series.length < 2) return []
  return series.every((value) => Number.isFinite(value)) ? series : []
}
