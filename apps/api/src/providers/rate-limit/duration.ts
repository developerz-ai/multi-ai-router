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
  let consumed = 0
  DURATION_PART.lastIndex = 0
  for (const part of trimmed.matchAll(DURATION_PART)) {
    if (part.index !== consumed) return null
    consumed += part[0].length
    const amount = Number(part[1])
    const unit = part[2]
    if (!Number.isFinite(amount) || unit === undefined) continue
    const factor = UNIT_SECONDS[unit]
    if (factor === undefined) continue
    total += amount * factor
    matched = true
  }
  if (matched) return consumed === trimmed.length && Number.isFinite(total) ? total : null

  const plain = Number(trimmed)
  return /^\d+(?:\.\d+)?$/.test(trimmed) && Number.isFinite(plain) ? plain : null
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

/**
 * Epoch **seconds** where a duration was expected: `x-ratelimit-reset: 1784000000`. Read as a
 * duration that parked an account until 2083. Every value from 1e9 (2001) up to the epoch-millis
 * floor is an instant in seconds — no limiter resets in 31 years — so it is read as one. The unit is
 * our inference, not the provider's statement, so callers label the reset `estimated`.
 *
 * Checked against the response's own `Date`, the one clock a parser has: an instant more than
 * `ceilingMs` past it is capped there (`9999999999` is 2286 — a misread, not a window), and with no
 * `Date` to check against the value is not trusted as a reset at all, so the breaker falls to its
 * own backoff rather than a park nobody can bound.
 *
 * This is the parser's own sanity bound on a unit it guessed, and only that. The operator's ceiling
 * on *every* reported reset — header, `Retry-After`, body stamp — is `ROUTING_MAX_REPORTED_RESET_SECONDS`,
 * applied once where a reset becomes a cooldown (`services/routing/backoff.ts`, `reportedReset`), so
 * a configured ceiling below this one still wins.
 */
const EPOCH_SECONDS_FLOOR = 1_000_000_000

/** No limiter documents a window longer than a week; past it, an inferred instant is a misread. */
export const EPOCH_SECONDS_CEILING_MS = 7 * 86_400_000

export function parseEpochSeconds(
  value: string,
  reference: Date | null,
  ceilingMs: number = EPOCH_SECONDS_CEILING_MS,
): Date | null {
  if (!isEpochSeconds(value) || reference === null) return null
  const ceiling = reference.getTime() + ceilingMs
  return new Date(Math.min(Number(value.trim()) * 1000, ceiling))
}

/** Whether a value is in the epoch-seconds range at all, whatever it then resolves to. */
export function isEpochSeconds(value: string): boolean {
  const trimmed = value.trim()
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return false
  const seconds = Number(trimmed)
  return seconds >= EPOCH_SECONDS_FLOOR && seconds < EPOCH_MILLIS_FLOOR
}
