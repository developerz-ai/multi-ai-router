// Presentation formatters. Pure: no clock read inside, no locale pinned — the
// caller passes `nowMs` where "now" matters, and the viewer's locale is used
// for everything else.
//
// These exist so a number is spelled the same way in every cell of the console.
// A count formatted `1.2k` in one table and `1200` in another is the kind of
// inconsistency an operator reads as two different measures.

const THOUSAND = 1000
const MILLION = 1_000_000
const BILLION = 1_000_000_000

/** Compact counts: `934`, `1.2k`, `18k`, `2.4M`. Exact below a thousand. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—"
  const abs = Math.abs(value)
  if (abs < THOUSAND) return String(Math.round(value))
  if (abs < MILLION) return `${trim(value / THOUSAND)}k`
  if (abs < BILLION) return `${trim(value / MILLION)}M`
  return `${trim(value / BILLION)}B`
}

/** One decimal, but never a trailing `.0` — `1.2k`, not `1.0k`. */
function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/**
 * Money, always with its currency and never rounded to zero when it is not:
 * a spend of a third of a cent reads `$0.0003`, because "$0.00" beside a
 * thousand requests looks like a broken meter.
 */
export function formatCost(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (value === 0) return "$0.00"
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`
  if (Math.abs(value) < 1000) return `$${value.toFixed(2)}`
  return `$${Math.round(value).toLocaleString()}`
}

/** A share as a percentage. `null` when there is nothing to divide by. */
export function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—"
  const share = (numerator / denominator) * 100
  return share < 1 && share > 0 ? `${share.toFixed(2)}%` : `${share.toFixed(1)}%`
}

/** Absolute local time, viewer's zone. The half of a timestamp that is a fact. */
export function formatTimestamp(iso: string | null, locale?: string): string {
  if (iso === null) return "—"
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return "—"
  return new Date(parsed).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
}

/** Date only — for expiry and created columns, where the minute is noise. */
export function formatDate(iso: string | null, locale?: string): string {
  if (iso === null) return "—"
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return "—"
  return new Date(parsed).toLocaleDateString(locale, { dateStyle: "medium" })
}

/** Time only, viewer's zone — for an hourly-bucketed chart axis, where the date is implied. */
export function formatTime(iso: string | null, locale?: string): string {
  if (iso === null) return "—"
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return "—"
  return new Date(parsed).toLocaleTimeString(locale, { timeStyle: "short" })
}

/**
 * `3m ago`, `in 2h`, `just now`. Always rendered *beside* the absolute time,
 * never instead of it — a relative stamp alone cannot be compared to a log.
 */
export function formatRelative(iso: string | null, nowMs: number): string {
  if (iso === null) return "never"
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return "—"

  const deltaMs = parsed - nowMs
  const abs = Math.abs(deltaMs)
  if (abs < 45_000) return "just now"

  const unit = pickUnit(abs)
  const amount = Math.round(deltaMs / unit.ms)
  return deltaMs < 0 ? `${Math.abs(amount)}${unit.suffix} ago` : `in ${amount}${unit.suffix}`
}

const UNITS = [
  { ms: 1000, suffix: "s" },
  { ms: 60_000, suffix: "m" },
  { ms: 3_600_000, suffix: "h" },
  { ms: 86_400_000, suffix: "d" },
] as const

function pickUnit(abs: number): { readonly ms: number; readonly suffix: string } {
  if (abs < 3_600_000) return UNITS[1]
  if (abs < 86_400_000) return UNITS[2]
  return UNITS[3]
}

/** Seconds as a rate-limit window: `60s`, `5m`, `1h`, `24h`. */
export function formatWindow(seconds: number): string {
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600}h`
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60}m`
  return `${seconds}s`
}

/** Truncates an id for a cell without pretending the rest is not there. */
export function shortId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`
}
