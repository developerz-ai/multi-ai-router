/**
 * Duration and instant parsing for rate-limit headers. Pure: an absolute header yields a `Date`,
 * a relative one yields seconds, and neither is converted into the other — that would need a
 * clock, and a driver is not handed one.
 */

const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
}

/**
 * OpenAI's `x-ratelimit-reset-*` form: `20ms`, `1s`, `6m0s`, `1h2m3s`. A bare number is read as
 * seconds, which is what the providers that omit the unit mean.
 */
export function parseDurationSeconds(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === "") return null

  let total = 0
  let matched = false
  DURATION_PART.lastIndex = 0
  for (const part of trimmed.matchAll(DURATION_PART)) {
    const amount = Number(part[1])
    const unit = part[2]
    if (!Number.isFinite(amount) || unit === undefined) continue
    const factor = UNIT_SECONDS[unit]
    if (factor === undefined) continue
    total += amount * factor
    matched = true
  }
  if (matched) return total

  const plain = Number(trimmed)
  return Number.isFinite(plain) ? plain : null
}

/** Anthropic's RFC 3339 reset headers, and any other absolute instant a provider reports. */
export function parseInstant(value: string): Date | null {
  const parsed = Date.parse(value.trim())
  return Number.isNaN(parsed) ? null : new Date(parsed)
}

/**
 * Epoch milliseconds, as OpenRouter reports on the unsuffixed `x-ratelimit-reset`. The threshold
 * keeps a small integer from being read as an instant in 1970 — anything below it is a duration.
 */
const EPOCH_MILLIS_FLOOR = 100_000_000_000

export function parseEpochMillis(value: string): Date | null {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const millis = Number(trimmed)
  if (!Number.isFinite(millis) || millis < EPOCH_MILLIS_FLOOR) return null
  return new Date(millis)
}
